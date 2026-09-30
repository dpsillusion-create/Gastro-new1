import { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { conflict, notFound } from '../errors';
import { assertRestaurantManager } from '../middleware/auth';
import { notifyFreelancerCancelled, notifyMatchCancelledByRestaurant, notifyNotSelected, notifySuspended } from './notifications';
import { enqueueEvent } from './webhooks';
import { SUSPENSION_DAYS, SUSPENSION_THRESHOLD } from './reliability';

/** Absage weniger als 24 Stunden vor Schichtbeginn gilt als kurzfristig und senkt die Zuverlässigkeit. */
export const LATE_CANCEL_HOURS = 24;
export const LATE_CANCEL_PENALTY = 0.1;

type Tx = Prisma.TransactionClient;

/** Nimmt die Zusage zurück: temporärer Mitarbeiter, Dienstplan-Eintrag und Meldedatensatz werden entfernt, die Schicht wird frei bzw. storniert. */
async function unmatch(tx: Tx, shiftId: string, by: 'FREELANCER' | 'RESTAURANT', opts: { reopen: boolean; reason?: string; now: Date }) {
  const shift = await tx.marketplaceShift.findUnique({ where: { id: shiftId }, include: { assignment: { include: { immediateNotification: true, freelancer: { select: { id: true, displayName: true, reliabilityScore: true } } } } } });
  if (!shift || !shift.assignment) throw notFound('Keine bestätigte Schicht gefunden');
  if (shift.status !== 'MATCHED') throw conflict('Nur bestätigte Schichten können abgesagt werden');
  const temp = shift.assignment;
  if (temp.clockedInAt || shift.startTime <= opts.now) throw conflict('Die Schicht hat bereits begonnen – eine Absage ist nicht mehr möglich');
  const hours = (shift.startTime.getTime() - opts.now.getTime()) / 3.6e6;
  const late = hours < LATE_CANCEL_HOURS;
  const reported = temp.immediateNotification?.status === 'SENT';

  await tx.immediateNotification.deleteMany({ where: { temporaryEmployeeId: temp.id } });
  await tx.rosterEntry.deleteMany({ where: { temporaryEmployeeId: temp.id } });
  await tx.temporaryEmployee.delete({ where: { id: temp.id } });
  const locked = await tx.marketplaceShift.updateMany({ where: { id: shiftId, status: 'MATCHED' }, data: { status: opts.reopen ? 'OPEN' : 'CANCELLED', version: { increment: 1 } } });
  if (locked.count !== 1) throw conflict('Die Schicht wurde gerade geändert');

  await tx.shiftApplication.updateMany({ where: { shiftId, freelancerId: temp.freelancerId, status: 'ACCEPTED' }, data: { status: by === 'FREELANCER' ? 'CANCELLED' : 'REJECTED', decidedAt: opts.now } });
  // Früher abgelehnte Bewerber sehen die frei gewordene Schicht wieder in der Suche (und werden informiert)
  let reoffered: string[] = [];
  if (opts.reopen) {
    const others = await tx.shiftApplication.findMany({ where: { shiftId, status: 'REJECTED', freelancerId: { not: temp.freelancerId } }, select: { id: true, freelancerId: true } });
    await tx.shiftApplication.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { status: 'WITHDRAWN', decidedAt: opts.now } });
    reoffered = others.map((o) => o.freelancerId);
  }
  await tx.shiftCancellation.create({ data: { shiftId, freelancerId: temp.freelancerId, cancelledBy: by, hoursBeforeStart: Math.round(hours * 10) / 10, late, reason: opts.reason?.slice(0, 300), sofortmeldungReported: reported } });
  await enqueueEvent(tx, 'shift_unmatched', { shiftId, restaurantId: shift.restaurantId, temporaryEmployeeId: temp.id, cancelledBy: by, reopened: opts.reopen });
  return { shift, temp, hours, late, reported, reoffered };
}

/** Die Aushilfe sagt eine bestätigte Schicht ab. Kurzfristig (< 24 h) → Score −0,10; bei Unterschreiten von 0,90 Sperre wie beim No-Show. */
export async function cancelByFreelancer(userId: string, shiftId: string, reason?: string, now = new Date()) {
  const f = await prisma.freelancer.findUnique({ where: { userId }, select: { id: true } });
  if (!f) throw notFound('Kein Freelancer-Profil');
  const out = await prisma.$transaction(async (tx) => {
    const shift = await tx.marketplaceShift.findUnique({ where: { id: shiftId }, select: { assignment: { select: { freelancerId: true } } } });
    if (!shift?.assignment || shift.assignment.freelancerId !== f.id) throw notFound('Keine bestätigte Schicht gefunden');
    const r = await unmatch(tx, shiftId, 'FREELANCER', { reopen: true, reason, now });
    let suspendedUntil: Date | null = null, score = r.temp.freelancer.reliabilityScore;
    if (r.late) {
      score = Math.max(0, +(score - LATE_CANCEL_PENALTY).toFixed(4));
      const suspend = score < SUSPENSION_THRESHOLD;
      suspendedUntil = suspend ? new Date(now.getTime() + SUSPENSION_DAYS * 86_400_000) : null;
      await tx.freelancer.update({ where: { id: f.id }, data: { reliabilityScore: score, lateCancelCount: { increment: 1 }, ...(suspend && { accountStatus: 'SUSPENDED', suspendedUntil }) } });
      if (suspend) await tx.shiftApplication.updateMany({ where: { freelancerId: f.id, status: 'PENDING' }, data: { status: 'WITHDRAWN', decidedAt: now } });
    }
    return { ...r, score, suspendedUntil };
  });
  notifyFreelancerCancelled(out.shift.restaurantId, shiftId, out.temp.freelancer.displayName, out.hours, out.late, out.reported);
  notifyNotSelected(shiftId, out.reoffered, 'REOPENED');
  if (out.suspendedUntil) notifySuspended(f.id, out.suspendedUntil);
  return { late: out.late, reliabilityScore: out.score, suspended: !!out.suspendedUntil };
}

/** Der Betrieb nimmt die Zusage zurück – die Schicht wird wieder ausgeschrieben (reopen) oder komplett abgesagt. Keine Strafe für die Aushilfe. */
export async function cancelByRestaurant(userId: string, shiftId: string, reopen: boolean, reason?: string, now = new Date()) {
  const s = await prisma.marketplaceShift.findUnique({ where: { id: shiftId }, select: { restaurantId: true } });
  if (!s) throw notFound('Schicht nicht gefunden');
  await assertRestaurantManager(userId, s.restaurantId);
  const out = await prisma.$transaction((tx) => unmatch(tx, shiftId, 'RESTAURANT', { reopen, reason, now }));
  notifyMatchCancelledByRestaurant(out.temp.freelancerId, shiftId, reopen, reason);
  if (reopen) notifyNotSelected(shiftId, out.reoffered, 'REOPENED');
  return { late: out.late, sofortmeldungReported: out.reported };
}
