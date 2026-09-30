import { createHash, randomBytes } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { notFound } from '../errors';
import { assertRestaurantOwner, authenticate } from '../middleware/auth';

/** API-Schlüssel eines Betriebs (für Zeiterfassungsterminal/Dienstplan-System). Nur der Inhaber verwaltet sie. */
export const restaurantRouter = Router();
restaurantRouter.use(authenticate);
const idParam = z.string().uuid();
export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

restaurantRouter.get('/:id/api-keys', async (req, res, next) => {
  try {
    const id = idParam.parse(req.params.id); await assertRestaurantOwner(req.userId!, id);
    res.json(await prisma.restaurantApiKey.findMany({ where: { restaurantId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true } }));
  } catch (e) { next(e); }
});

/** Erzeugt einen Schlüssel. Er wird NUR EINMAL im Klartext angezeigt (gespeichert wird nur der Hash). */
restaurantRouter.post('/:id/api-keys', async (req, res, next) => {
  try {
    const id = idParam.parse(req.params.id); await assertRestaurantOwner(req.userId!, id);
    const { name } = z.object({ name: z.string().trim().min(2).max(60) }).strict().parse(req.body);
    const key = 'ge_' + randomBytes(24).toString('base64url');
    const rec = await prisma.restaurantApiKey.create({ data: { restaurantId: id, name, prefix: key.slice(0, 8), keyHash: hashKey(key) } });
    res.status(201).json({ id: rec.id, name, prefix: rec.prefix, key });
  } catch (e) { next(e); }
});

restaurantRouter.delete('/:id/api-keys/:keyId', async (req, res, next) => {
  try {
    const id = idParam.parse(req.params.id); await assertRestaurantOwner(req.userId!, id);
    const r = await prisma.restaurantApiKey.updateMany({ where: { id: idParam.parse(req.params.keyId), restaurantId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count !== 1) throw notFound('Schlüssel nicht gefunden');
    res.status(204).end();
  } catch (e) { next(e); }
});
