import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { conflict, notFound, unauthorized } from '../errors';
import { recordClockIn } from '../services/reliability';
import { hashKey } from './restaurants';

/**
 * Schnittstelle für Zeiterfassungsterminal / Dienstplan-System eines Betriebs. Authentifizierung per API-Schlüssel
 * (`Authorization: Bearer ge_…`); ein Schlüssel gilt nur für SEIN Restaurant und kann nichts anderes als unten beschrieben.
 */
export const integrationRouter = Router();
declare module 'express-serve-static-core' { interface Request { restaurantId?: string } }

integrationRouter.use(async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ge_')) throw unauthorized('API-Schlüssel fehlt');
    const key = await prisma.restaurantApiKey.findUnique({ where: { keyHash: hashKey(h.slice(7)) }, include: { restaurant: { select: { blockedAt: true } } } });
    if (!key || key.revokedAt || key.restaurant.blockedAt) throw unauthorized('API-Schlüssel ungültig');
    req.restaurantId = key.restaurantId;
    await prisma.restaurantApiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    next();
  } catch (e) { next(e); }
});

/** Das Terminal meldet: die zugesagte Aushilfe hat eingecheckt. */
integrationRouter.post('/clock-in', async (req, res, next) => {
  try {
    const { shiftId } = z.object({ shiftId: z.string().uuid() }).strict().parse(req.body);
    const s = await prisma.marketplaceShift.findFirst({ where: { id: shiftId, restaurantId: req.restaurantId }, select: { status: true, startTime: true } });
    if (!s) throw notFound('Schicht nicht gefunden');
    if (s.status !== 'MATCHED') throw conflict('Nur bestätigte Schichten');
    if (Date.now() < s.startTime.getTime() - 30 * 60_000) throw conflict('Einchecken frühestens 30 Minuten vor Schichtbeginn');
    await recordClockIn(shiftId);
    res.status(204).end();
  } catch (e) { next(e); }
});

/** Dienstplan-Abgleich: bestätigte/abgeschlossene Schichten des Betriebs (ohne sensible Personendaten). */
integrationRouter.get('/shifts', async (req, res, next) => {
  try {
    const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
    const from = q.from ?? new Date(Date.now() - 86_400_000), to = q.to ?? new Date(Date.now() + 14 * 86_400_000);
    const list = await prisma.marketplaceShift.findMany({
      where: { restaurantId: req.restaurantId, status: { in: ['MATCHED', 'COMPLETED'] }, startTime: { gte: from, lte: to } }, orderBy: { startTime: 'asc' }, take: 200,
      select: { id: true, role: true, startTime: true, endTime: true, hourlyRateCents: true, status: true,
        assignment: { select: { id: true, clockedInAt: true, noShowRecordedAt: true, freelancer: { select: { displayName: true } } } } },
    });
    res.json(list.map(({ assignment: a, ...s }) => ({ ...s, temporaryEmployee: a ? { id: a.id, name: a.freelancer.displayName, clockedInAt: a.clockedInAt, noShow: !!a.noShowRecordedAt } : null })));
  } catch (e) { next(e); }
});
