import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { DEFAULT_RADIUS_KM, MAX_RADIUS_KM } from '../config';
import { badRequest, unauthorized } from '../errors';
import { assertRestaurantManager, authenticate, requireFreelancer } from '../middleware/auth';
import { decrypt } from '../services/crypto';
import * as svc from '../services/marketplaceService';

const Skill = z.enum(['BAR', 'SERVICE', 'KITCHEN', 'DISHWASHING']);
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) => { fn(req, res).catch(next); };
const uid = (req: Request) => req.userId ?? (() => { throw unauthorized(); })();

const createSchema = z.object({
  restaurantId: z.string().uuid(),
  role: z.string().min(2).max(80),
  requiredSkill: Skill,
  requirements: z.string().max(500).optional(),
  activityKey: z.string().regex(/^\d{9}$/).optional(),
  hourlyRateCents: z.number().int().min(1200).max(20000), // 12–200 €/h (Mindestlohn-Plausibilität)
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
}).refine(v => v.endTime > v.startTime, { message: 'endTime muss nach startTime liegen' })
  .refine(v => v.endTime.getTime() - v.startTime.getTime() <= 14 * 3600_000, { message: 'Schicht max. 14 Stunden' })
  .refine(v => v.endTime > new Date(), { message: 'Schicht liegt in der Vergangenheit' });

const searchSchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().positive().max(MAX_RADIUS_KM).default(DEFAULT_RADIUS_KM),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const idParam = z.string().uuid();

export const marketplaceRouter = Router();
marketplaceRouter.use(authenticate);

/** Wirt: offene Schicht erstellen. */
marketplaceRouter.post('/shifts', wrap(async (req, res) => {
  const input = createSchema.parse(req.body);
  const shift = await svc.createShift(uid(req), input);
  res.status(201).json(shift);
}));

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
    select: { freelancer: { select: { id: true, displayName: true, verifiedSkills: true, ratingSum: true, ratingCount: true } } },
  });
  res.json(apps.map(a => ({
    ...a.freelancer,
    rating: a.freelancer.ratingCount ? +(a.freelancer.ratingSum / a.freelancer.ratingCount).toFixed(2) : null,
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
