import { Prisma } from '@prisma/client';
import { prisma } from '../db';

/** Protokolliert sensible Verwaltungsaktionen (wer hat wann was mit wem gemacht). Ohne Personendaten im Klartext. */
export function audit(actorId: string | null, action: string, targetType: string, targetId: string, meta?: Prisma.InputJsonObject) {
  return prisma.auditLog.create({ data: { actorId, action, targetType, targetId, meta } }).catch((e) => console.error('[audit]', (e as Error).message));
}
