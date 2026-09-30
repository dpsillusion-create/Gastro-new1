import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM, MIN_WAGE_CENTS } from '../config';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { assertRestaurantManager, assertRestaurantOwner, authenticate, requireFreelancer } from '../middleware/auth';
import { decrypt, decryptBuffer } from '../services/crypto';
import * as svc from '../services/marketplaceService';
import { notifyNotSelected } from '../services/notifications';
import { cancelByFreelancer, cancelByRestaurant } from '../services/assignment';
import { markSofortmeldungReported, setActivityKey } from '../services/sofortmeldung';
import { recordClockIn, registerNoShow } from '../services/reliability';

const Skill = z.enum(['BAR', 'SERVICE', 'KITCHEN', 'DISHWASHING']);
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) => { fn(req, res).catch(next); };
const uid = (req: Request) => req.userId ?? (() => { throw unauthorized(); })();

const ROLES = ['Barkeeper', 'Service', 'Servicekraft', 'Koch', 'Küchenhilfe', 'Spüler'] as const;

const createSchema = z.object({
  restaurantId: z.string().uuid('restaurantId muss eine UUID sein'),
  role: z.enum(ROLES, { errorMap: () => ({ message: `role muss eines von ${ROLES.join(', ')} sein` }) }),
  requiredSkill: Skill,
  requirements: z.string().trim().max(500).optional(),
  activityKey: z.string().regex(/^\d{9}$/, 'activityKey: 9 Ziffern').optional(),
  positions: z.number().int().min(1).max(10).default(1),
  hourlyRateCents: z.number().int(`hourlyRateCents muss eine ganze Zahl in Cent sein`)
    .min(MIN_WAGE_CENTS, `Stundensatz unter dem Mindestlohn (${(MIN_WAGE_CENTS / 100).toFixed(2).replace('.', ',')} €/h)`)
    .max(20000, 'Stundensatz unplausibel hoch'),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
}).strict()
  .refine(v => v.startTime > new Date(), { path: ['startTime'], message: 'startTime muss in der Zukunft liegen' })
  .refine(v => v.endTime > v.startTime, { path: ['endTime'], message: 'endTime muss nach startTime liegen' })
  .refine(v => v.endTime.getTime() - v.startTime.getTime() <= 14 * 3600_000, { path: ['endTime'], message: 'Schicht max. 14 Stunden' });

const searchSchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(MAX_RADIUS_KM).default(DEFAULT_RADIUS_KM),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const idParam = z.string().uuid();

export const marketplaceRouter = Router();
marketplaceRouter.use(authenticate);

/**
 * Inhaber: offene Schicht erstellen.
 * 201 Created | 400 Validierung | 401 nicht angemeldet | 403 kein Inhaber dieses Restaurants | 500 unerwartet
 */
marketplaceRouter.post('/shifts', async (req, res, next) => {
  try {
    const input = createSchema.parse(req.body); // 400 bei Fehlern (ZodError → Error-Handler)
    const shift = await svc.createShift(uid(req), input); // prüft Inhaberschaft (403), setzt status OPEN
    res.status(201).location(`/api/v1/marketplace/shifts/${shift.id}`).json(shift);
  } catch (err) {
    next(err); // zentraler Handler in app.ts: ZodError→400, HttpError→Status, sonst 500 ohne Details
  }
});

/** Freelancer: Schichten im Umkreis, passend zu verifizierten Skills. */
marketplaceRouter.get('/search', wrap(async (req, res) => {
  const q = searchSchema.parse(req.query);
  const f = await requireFreelancer(uid(req));
  const lat = q.lat ?? f.homeLatitude, lon = q.lon ?? f.homeLongitude;
  if (lat == null || lon == null) throw badRequest('Standort (lat/lon) fehlt');
  const shifts = await svc.searchShifts({
    freelancerId: f.id, skills: f.verifiedSkills, lat, lon, radiusKm: q.radiusKm, limit: q.limit,
  });
  res.json({ count: shifts.length, shifts });
}));

/** Freelancer: bewerben/swipen. */
marketplaceRouter.post('/shifts/:id/apply', wrap(async (req, res) => {
  const shiftId = idParam.parse(req.params.id);
  const f = await requireFreelancer(uid(req));
  const app = await svc.applyToShift(f, shiftId);
  res.status(201).json({ applicationId: app.id, status: app.status });
}));

/** Wirt: Bewerber bestätigen → MATCHED + Integrations-Hook. */
marketplaceRouter.post('/shifts/:id/accept', wrap(async (req, res) => {
  const shiftId = idParam.parse(req.params.id);
  const { freelancerId } = z.object({ freelancerId: z.string().uuid() }).parse(req.body);
  res.json(await svc.acceptApplication(uid(req), shiftId, freelancerId));
}));

/** Wirt: Bewerberliste (Kurzprofil, ohne Sozialversicherungsdaten). */
marketplaceRouter.get('/shifts/:id/applications', wrap(async (req, res) => {
  const shiftId = idParam.parse(req.params.id);
  const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId } });
  if (!shift) throw badRequest('Schicht nicht gefunden');
  await assertRestaurantManager(uid(req), shift.restaurantId);
  const apps = await prisma.shiftApplication.findMany({
    where: { shiftId, status: 'PENDING' },
    select: { freelancer: { select: { id: true, displayName: true, verifiedSkills: true, ratingSum: true, ratingCount: true, hygieneCertificate: { select: { issuedOn: true } } } } },
  });
  res.json(apps.map(({ freelancer: { hygieneCertificate, ...f } }) => ({
    ...f, hygieneIssuedOn: hygieneCertificate?.issuedOn ?? null,
    rating: f.ratingCount ? +(f.ratingSum / f.ratingCount).toFixed(2) : null,
  })));
}));

/** Wirt: exportbereite DEÜV-Meldedaten der Sofortmeldung (enthält Personendaten → strikt autorisiert, no-store). */
marketplaceRouter.get('/shifts/:id/sofortmeldung-export', wrap(async (req, res) => {
  const shiftId = idParam.parse(req.params.id);
  const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId } });
  if (!shift) throw badRequest('Schicht nicht gefunden');
  await assertRestaurantManager(uid(req), shift.restaurantId);
  const n = await prisma.immediateNotification.findFirst({ where: { temporaryEmployee: { shiftId } } });
  if (!n) throw badRequest('Noch kein Match für diese Schicht');
  res.set('Cache-Control', 'no-store').json({
    status: n.status, missingFields: n.missingFields, data: JSON.parse(decrypt(n.payloadEnc)),
  });
}));

/** Inhaber/Manager: eigene Schichten (alle zugeordneten Restaurants) inkl. Anzahl offener Bewerbungen. */
marketplaceRouter.get('/my-shifts', async (req, res, next) => {
  try {
    const shifts = await prisma.marketplaceShift.findMany({
      where: { restaurant: { members: { some: { userId: uid(req), role: { in: ['OWNER', 'MANAGER'] } } } } },
      orderBy: { startTime: 'desc' }, take: 100,
      select: {
        id: true, role: true, requiredSkill: true, requirements: true, activityKey: true, hourlyRateCents: true, startTime: true,
        endTime: true, status: true, rating: true, slotIndex: true, slotCount: true, restaurant: { select: { id: true, name: true } },
        _count: { select: { applications: { where: { status: 'PENDING' } } } },
        assignment: { select: {
          clockedInAt: true, noShowRecordedAt: true, freelancer: { select: { displayName: true } },
          immediateNotification: { select: { status: true, missingFields: true, reportedAt: true, reference: true } },
        } },
      },
    });
    res.json(shifts.map(({ _count, assignment, ...s }) => ({
      ...s, pendingApplications: _count.applications, sofortmeldung: assignment?.immediateNotification ?? null,
      assignment: assignment ? { clockedInAt: assignment.clockedInAt, noShowRecordedAt: assignment.noShowRecordedAt, freelancer: assignment.freelancer } : null,
    })));
  } catch (err) { next(err); }
});

/** Inhaber: offene Schicht zurückziehen. */
marketplaceRouter.post('/shifts/:id/cancel', async (req, res, next) => {
  try {
    const shiftId = idParam.parse(req.params.id);
    const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw notFound('Schicht nicht gefunden');
    await assertRestaurantOwner(uid(req), shift.restaurantId);
    const waiting = await prisma.shiftApplication.findMany({ where: { shiftId, status: 'PENDING' }, select: { freelancerId: true } });
    const r = await prisma.marketplaceShift.updateMany({ where: { id: shiftId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
    if (r.count !== 1) throw conflict('Nur offene Schichten können zurückgezogen werden');
    notifyNotSelected(shiftId, waiting.map((w) => w.freelancerId), 'CANCELLED');
    res.status(204).end();
  } catch (err) { next(err); }
});

/** Freelancer: eigene offene Bewerbung zurückziehen. */
marketplaceRouter.post('/shifts/:id/withdraw', async (req, res, next) => {
  try {
    const shiftId = idParam.parse(req.params.id);
    const f = await prisma.freelancer.findUnique({ where: { userId: uid(req) }, select: { id: true } });
    if (!f) throw forbidden('Kein Freelancer-Profil');
    await svc.withdrawApplication(f.id, shiftId);
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * Wirt/Manager: Anwesenheit der bestätigten Aushilfe melden (bis das Zeiterfassungsterminal automatisch einchecken lässt).
 * PRESENT = ist erschienen (Einchecken, ab 30 Min. vor Beginn); NO_SHOW = nicht erschienen (frühestens 15 Min. nach Beginn)
 * → senkt den Zuverlässigkeits-Score und sperrt die Aushilfe (siehe services/reliability.ts).
 */
marketplaceRouter.post('/shifts/:id/attendance', async (req, res, next) => {
  try {
    const shiftId = idParam.parse(req.params.id);
    const { status } = z.object({ status: z.enum(['PRESENT', 'NO_SHOW']) }).strict().parse(req.body);
    const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId } });
    if (!shift) throw notFound('Schicht nicht gefunden');
    await assertRestaurantManager(uid(req), shift.restaurantId);
    if (shift.status !== 'MATCHED') throw conflict('Nur bestätigte Schichten');
    if (status === 'PRESENT') {
      if (Date.now() < shift.startTime.getTime() - 30 * 60_000) throw conflict('Einchecken frühestens 30 Minuten vor Schichtbeginn');
      await recordClockIn(shiftId);
      return void res.status(204).end();
    }
    res.json(await registerNoShow(shiftId));
  } catch (err) { next(err); }
});

/** Wirt/Manager: Schicht abschließen und die Aushilfe bewerten (1–5 Sterne). */
marketplaceRouter.post('/shifts/:id/complete', async (req, res, next) => {
  try {
    const shiftId = idParam.parse(req.params.id);
    const { rating } = z.object({ rating: z.number().int().min(1).max(5) }).strict().parse(req.body);
    await svc.completeShift(uid(req), shiftId, rating);
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * Wirt/Manager: Hygienenachweis der bestätigten Aushilfe ansehen (Nachweispflicht des Arbeitgebers).
 * Nur für Schichten dieses Restaurants im Status MATCHED/COMPLETED – vor der Zusage sind keine Dokumente einsehbar.
 */
marketplaceRouter.get('/shifts/:id/hygiene-certificate', async (req, res, next) => {
  try {
    const shiftId = idParam.parse(req.params.id);
    const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId }, select: { restaurantId: true, status: true, assignment: { select: { freelancerId: true } } } });
    if (!shift) throw notFound('Schicht nicht gefunden');
    await assertRestaurantManager(uid(req), shift.restaurantId);
    if (!shift.assignment || (shift.status !== 'MATCHED' && shift.status !== 'COMPLETED')) throw forbidden('Erst nach der Zusage einsehbar');
    const cert = await prisma.hygieneCertificate.findUnique({ where: { freelancerId: shift.assignment.freelancerId } });
    if (!cert) throw notFound('Kein Hygienenachweis hinterlegt');
    res.set({ 'Content-Type': cert.mimeType, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline; filename="hygienenachweis"' })
      .send(decryptBuffer(Buffer.from(cert.dataEnc)));
  } catch (err) { next(err); }
});

// ---- Sofortmeldung: geführter Ablauf ----
/** Betrieb markiert die Sofortmeldung als bei der Sozialversicherung abgegeben (optional mit Referenz). */
marketplaceRouter.post('/shifts/:id/sofortmeldung/reported', async (req, res, next) => {
  try {
    const { reference } = z.object({ reference: z.string().trim().max(60).optional() }).strict().parse(req.body ?? {});
    await markSofortmeldungReported(uid(req), idParam.parse(req.params.id), reference);
    res.status(204).end();
  } catch (err) { next(err); }
});
/** Betrieb ergänzt den fehlenden Tätigkeitsschlüssel (9 Ziffern); die Meldedaten werden neu aufgebaut. */
marketplaceRouter.put('/shifts/:id/activity-key', async (req, res, next) => {
  try {
    const { activityKey } = z.object({ activityKey: z.string().regex(/^\d{9}$/, 'Tätigkeitsschlüssel: 9 Ziffern') }).strict().parse(req.body);
    res.json(await setActivityKey(uid(req), idParam.parse(req.params.id), activityKey));
  } catch (err) { next(err); }
});

// ---- Absagen nach der Zusage ----
/** Aushilfe sagt eine bestätigte Schicht ab (kurzfristige Absage < 24 h senkt die Zuverlässigkeit). */
marketplaceRouter.post('/shifts/:id/cancel-assignment', async (req, res, next) => {
  try {
    const { reason } = z.object({ reason: z.string().trim().max(300).optional() }).strict().parse(req.body ?? {});
    res.json(await cancelByFreelancer(uid(req), idParam.parse(req.params.id), reason));
  } catch (err) { next(err); }
});
/** Betrieb nimmt die Zusage zurück: `reopen: true` schreibt die Schicht neu aus, `false` sagt sie ganz ab. */
marketplaceRouter.post('/shifts/:id/cancel-match', async (req, res, next) => {
  try {
    const b = z.object({ reopen: z.boolean(), reason: z.string().trim().max(300).optional() }).strict().parse(req.body);
    res.json(await cancelByRestaurant(uid(req), idParam.parse(req.params.id), b.reopen, b.reason));
  } catch (err) { next(err); }
});
