import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { HttpError } from '../errors';
import { authenticate } from '../middleware/auth';
import { isAllowedPushEndpoint, pushEnabled, vapidPublicKey } from '../services/push';

/** Geräte für Push-Nachrichten an- und abmelden (angemeldete Nutzer). */
export const pushRouter = Router();
pushRouter.use(authenticate);
const MAX_DEVICES = 10;

pushRouter.get('/public-key', (_req, res, next) => {
  if (!pushEnabled()) return next(new HttpError(404, 'PUSH_DISABLED', 'Push-Nachrichten sind nicht eingerichtet'));
  res.json({ publicKey: vapidPublicKey() });
});

pushRouter.post('/subscribe', async (req, res, next) => {
  try {
    const b = z.object({
      endpoint: z.string().url().max(1000).refine(isAllowedPushEndpoint, 'Unbekannter Push-Dienst'),
      keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
    }).parse(req.body);
    const userId = req.userId!;
    await prisma.pushSubscription.upsert({
      where: { endpoint: b.endpoint }, create: { userId, endpoint: b.endpoint, p256dh: b.keys.p256dh, auth: b.keys.auth, userAgent: req.get('user-agent')?.slice(0, 200) },
      update: { userId, p256dh: b.keys.p256dh, auth: b.keys.auth }, // Gerät gehört jetzt diesem Nutzer (z. B. nach Kontowechsel)
    });
    const all = await prisma.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (all.length > MAX_DEVICES) await prisma.pushSubscription.deleteMany({ where: { id: { in: all.slice(MAX_DEVICES).map((x) => x.id) } } });
    res.status(204).end();
  } catch (e) { next(e); }
});

pushRouter.post('/unsubscribe', async (req, res, next) => {
  try {
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).strict().parse(req.body);
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.userId! } });
    res.status(204).end();
  } catch (e) { next(e); }
});
