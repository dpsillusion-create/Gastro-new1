import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { conflict, forbidden, notFound } from '../errors';
import { authenticate } from '../middleware/auth';
import { anonymizeUser } from '../services/accountDeletion';
import { audit } from '../services/audit';
import { decryptBuffer } from '../services/crypto';

/** Verwaltungs-API – nur für Nutzer mit `isAdmin` (Vergabe ausschließlich per scripts/admin.ts auf dem Server). */
export const adminRouter = Router();
adminRouter.use(authenticate, async (req, _res, next) => {
  try {
    const u = await prisma.user.findUnique({ where: { id: req.userId! }, select: { isAdmin: true, deletedAt: true, totpEnabledAt: true } });
    if (!u?.isAdmin || u.deletedAt) return next(forbidden('Nur für Administratoren'));
    // Administratoren sehen Personendaten und Nachweise aller Nutzer → zweiter Faktor per Authenticator-App ist Pflicht
    next(u.totpEnabledAt ? undefined : forbidden('Bitte richte zuerst die Authenticator-App ein (Betriebs-Oberfläche → Einstellungen → Sicherheit).'));
  } catch (e) { next(e); }
});
const uid = (req: { userId?: string }) => req.userId!;
const idParam = z.string().uuid();

adminRouter.get('/stats', async (_req, res, next) => {
  try {
    const [freelancers, verified, suspended, restaurants, blocked, open, matched, completed] = await Promise.all([
      prisma.freelancer.count({ where: { user: { deletedAt: null } } }), prisma.freelancer.count({ where: { verified: true } }),
      prisma.freelancer.count({ where: { accountStatus: 'SUSPENDED' } }), prisma.restaurant.count(), prisma.restaurant.count({ where: { blockedAt: { not: null } } }),
      prisma.marketplaceShift.count({ where: { status: 'OPEN' } }), prisma.marketplaceShift.count({ where: { status: 'MATCHED' } }), prisma.marketplaceShift.count({ where: { status: 'COMPLETED' } }),
    ]);
    res.json({ freelancers, verified, suspended, restaurants, blocked, shifts: { open, matched, completed } });
  } catch (e) { next(e); }
});

adminRouter.get('/freelancers', async (req, res, next) => {
  try {
    const q = z.object({ q: z.string().max(100).optional() }).parse(req.query).q?.trim();
    const list = await prisma.freelancer.findMany({
      where: { user: { deletedAt: null }, ...(q ? { OR: [{ displayName: { contains: q, mode: 'insensitive' } }, { user: { email: { contains: q.toLowerCase() } } }] } : {}) },
      orderBy: { createdAt: 'desc' }, take: 100,
      include: { user: { select: { email: true, phone: true } }, hygieneCertificate: { select: { issuedOn: true } } },
    });
    res.json(list.map((f) => ({
      id: f.id, userId: f.userId, displayName: f.displayName, email: f.user.email, phone: f.user.phone, verified: f.verified,
      skills: f.verified ? f.verifiedSkills : f.claimedSkills, accountStatus: f.accountStatus, suspendedUntil: f.suspendedUntil,
      reliabilityScore: f.reliabilityScore, noShowCount: f.noShowCount, rating: f.ratingCount ? +(f.ratingSum / f.ratingCount).toFixed(2) : null,
      ratingCount: f.ratingCount, hygieneIssuedOn: f.hygieneCertificate?.issuedOn ?? null, createdAt: f.createdAt,
    })));
  } catch (e) { next(e); }
});

/** Sperren / Entsperren / Freischaltung entziehen bzw. erteilen. */
adminRouter.post('/freelancers/:id/:action', async (req, res, next) => {
  try {
    const id = idParam.parse(req.params.id);
    const action = z.enum(['suspend', 'unsuspend', 'verify', 'unverify']).parse(req.params.action);
    const f = await prisma.freelancer.findUnique({ where: { id } });
    if (!f) throw notFound('Aushilfe nicht gefunden');
    if (action === 'suspend') {
      const { days } = z.object({ days: z.number().int().min(1).max(3650) }).strict().parse(req.body);
      await prisma.freelancer.update({ where: { id }, data: { accountStatus: 'SUSPENDED', suspendedUntil: new Date(Date.now() + days * 86_400_000) } });
      await prisma.shiftApplication.updateMany({ where: { freelancerId: id, status: 'PENDING' }, data: { status: 'WITHDRAWN', decidedAt: new Date() } });
    } else if (action === 'unsuspend') await prisma.freelancer.update({ where: { id }, data: { accountStatus: 'ACTIVE', suspendedUntil: null } });
    else if (action === 'verify') await prisma.freelancer.update({ where: { id }, data: { verified: true, verifiedSkills: f.claimedSkills.length ? f.claimedSkills : f.verifiedSkills } });
    else await prisma.freelancer.update({ where: { id }, data: { verified: false } });
    await audit(uid(req), `freelancer.${action}`, 'Freelancer', id, req.body && typeof req.body === 'object' ? req.body : undefined);
    res.status(204).end();
  } catch (e) { next(e); }
});

/** Hygienenachweis einsehen (wird protokolliert). */
adminRouter.get('/freelancers/:id/hygiene-certificate', async (req, res, next) => {
  try {
    const id = idParam.parse(req.params.id);
    const cert = await prisma.hygieneCertificate.findUnique({ where: { freelancerId: id } });
    if (!cert) throw notFound('Kein Hygienenachweis hinterlegt');
    await audit(uid(req), 'hygiene-certificate.view', 'Freelancer', id);
    res.set({ 'Content-Type': cert.mimeType, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'inline; filename="hygienenachweis"' }).send(decryptBuffer(Buffer.from(cert.dataEnc)));
  } catch (e) { next(e); }
});

adminRouter.get('/restaurants', async (req, res, next) => {
  try {
    const q = z.object({ q: z.string().max(100).optional() }).parse(req.query).q?.trim();
    const list = await prisma.restaurant.findMany({
      where: q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { city: { contains: q, mode: 'insensitive' } }] } : {},
      orderBy: { name: 'asc' }, take: 100,
      include: { members: { where: { role: 'OWNER' }, include: { user: { select: { email: true } } } }, _count: { select: { shifts: true } } },
    });
    res.json(list.map((r) => ({ id: r.id, name: r.name, city: r.city, zip: r.zip, betriebsnummer: r.employerBetriebsnummer, blockedAt: r.blockedAt,
      owners: r.members.map((m) => m.user.email), shifts: r._count.shifts })));
  } catch (e) { next(e); }
});

/** Betrieb sperren (zieht offene Schichten zurück) bzw. entsperren. */
adminRouter.post('/restaurants/:id/:action', async (req, res, next) => {
  try {
    const id = idParam.parse(req.params.id); const action = z.enum(['block', 'unblock']).parse(req.params.action);
    if (!(await prisma.restaurant.findUnique({ where: { id }, select: { id: true } }))) throw notFound('Betrieb nicht gefunden');
    if (action === 'block') {
      await prisma.$transaction([
        prisma.restaurant.update({ where: { id }, data: { blockedAt: new Date() } }),
        prisma.marketplaceShift.updateMany({ where: { restaurantId: id, status: 'OPEN' }, data: { status: 'CANCELLED' } }),
      ]);
    } else await prisma.restaurant.update({ where: { id }, data: { blockedAt: null } });
    await audit(uid(req), `restaurant.${action}`, 'Restaurant', id);
    res.status(204).end();
  } catch (e) { next(e); }
});

/** Konto löschen (anonymisieren) – z. B. auf Wunsch des Nutzers (DSGVO). */
adminRouter.delete('/users/:id', async (req, res, next) => {
  try {
    const id = idParam.parse(req.params.id);
    if (id === uid(req)) throw conflict('Das eigene Konto kann hier nicht gelöscht werden');
    await anonymizeUser(id);
    await audit(uid(req), 'user.anonymize', 'User', id);
    res.status(204).end();
  } catch (e) { next(e); }
});

adminRouter.get('/audit', async (_req, res, next) => {
  try { res.json(await prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 100 })); } catch (e) { next(e); }
});
