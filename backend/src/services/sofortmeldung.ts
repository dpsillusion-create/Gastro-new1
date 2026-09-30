import { prisma } from '../db';
import { conflict, notFound } from '../errors';
import { assertRestaurantManager } from '../middleware/auth';
import { buildDeuevData } from './deuev';
import { encrypt } from './crypto';
import { sendSofortmeldungReminder } from './notifications';

async function loadForManager(userId: string, shiftId: string) {
  const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId }, include: { restaurant: true, assignment: { include: { freelancer: true, immediateNotification: true } } } });
  if (!shift) throw notFound('Schicht nicht gefunden');
  await assertRestaurantManager(userId, shift.restaurantId);
  if (!shift.assignment?.immediateNotification || (shift.status !== 'MATCHED' && shift.status !== 'COMPLETED')) throw conflict('Keine Sofortmeldung für diese Schicht');
  return { shift, temp: shift.assignment, notification: shift.assignment.immediateNotification };
}

/** Der Betrieb bestätigt: Sofortmeldung wurde bei der Sozialversicherung abgegeben (optional mit Referenz). */
export async function markSofortmeldungReported(userId: string, shiftId: string, reference?: string) {
  const { notification } = await loadForManager(userId, shiftId);
  if (notification.status === 'SENT') throw conflict('Bereits als gemeldet markiert');
  await prisma.immediateNotification.update({ where: { id: notification.id }, data: { status: 'SENT', reportedAt: new Date(), reference: reference?.slice(0, 60) ?? null } });
}

/** Ergänzt den fehlenden Tätigkeitsschlüssel und baut die Meldedaten neu auf (READY, sobald nichts mehr fehlt). */
export async function setActivityKey(userId: string, shiftId: string, activityKey: string) {
  const { shift, temp, notification } = await loadForManager(userId, shiftId);
  if (notification.status === 'SENT') throw conflict('Bereits gemeldet – nachträgliche Änderung nicht möglich');
  const updated = await prisma.marketplaceShift.update({ where: { id: shiftId }, data: { activityKey } });
  const { data, missing } = buildDeuevData(temp.freelancer, updated, shift.restaurant);
  await prisma.immediateNotification.update({ where: { id: notification.id }, data: { payloadEnc: encrypt(JSON.stringify(data)), missingFields: missing, status: missing.length ? 'NEEDS_DATA' : 'READY' } });
  return { status: missing.length ? 'NEEDS_DATA' : 'READY', missingFields: missing };
}

/** Worker: erinnert Betriebe, deren Sofortmeldung 3 Stunden vor Schichtbeginn (oder danach) noch nicht als gemeldet markiert ist. */
export async function remindSofortmeldung(now = new Date()) {
  const due = await prisma.immediateNotification.findMany({
    where: { status: { not: 'SENT' }, reminderSentAt: null, temporaryEmployee: { validFrom: { lte: new Date(now.getTime() + 3 * 3600_000) }, validUntil: { gt: now } } },
    include: { temporaryEmployee: { include: { freelancer: { select: { displayName: true } }, shift: { select: { role: true, startTime: true } },
      restaurant: { include: { members: { where: { role: { in: ['OWNER', 'MANAGER'] } }, include: { user: { select: { email: true } } } } } } } } },
  });
  for (const n of due) {
    const claim = await prisma.immediateNotification.updateMany({ where: { id: n.id, reminderSentAt: null }, data: { reminderSentAt: now } });
    if (claim.count !== 1) continue;
    const t = n.temporaryEmployee;
    for (const m of t.restaurant.members) await sendSofortmeldungReminder(m.user.email, t.freelancer.displayName, t.shift.role, t.shift.startTime);
  }
  return due.length;
}
