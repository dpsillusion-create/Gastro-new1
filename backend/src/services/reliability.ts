import { prisma } from '../db';
import { conflict, notFound } from '../errors';
import { notifySuspended, sendAttendanceReminder } from './notifications';

/** Drastischer Abzug pro No-Show: ein einziger Vorfall (1.0 → 0.75) führt bereits zur Sperre. */
export const NO_SHOW_PENALTY = 0.25;
export const SUSPENSION_THRESHOLD = 0.9;
export const SUSPENSION_DAYS = 30;
/** Toleranz nach Schichtbeginn, bevor ein fehlendes Einchecken als No-Show gilt. */
export const NO_SHOW_GRACE_MINUTES = 15;
/** Score nach Ablauf der Sperre: Bewährung – der nächste No-Show sperrt sofort wieder. */
const PROBATION_SCORE = SUSPENSION_THRESHOLD;

/** Reine Funktion (testbar): neuer Score + Sperrentscheidung. */
export function applyNoShowPenalty(score: number) {
  const next = Math.max(0, +(score - NO_SHOW_PENALTY).toFixed(4));
  return { score: next, suspend: next < SUSPENSION_THRESHOLD };
}

/** Vom Zeiterfassungsterminal aufgerufen, wenn der Freelancer einstempelt. */
export async function recordClockIn(shiftId: string, at = new Date()) {
  const r = await prisma.temporaryEmployee.updateMany({
    where: { shiftId, clockedInAt: null, noShowRecordedAt: null },
    data: { clockedInAt: at },
  });
  if (r.count !== 1) throw conflict('Einchecken nicht möglich (bereits eingecheckt oder No-Show erfasst)');
}

/**
 * Registriert einen No-Show (Match vorhanden, aber kein Einchecken bis Schichtbeginn + Toleranz).
 * Idempotent: mehrfacher Aufruf senkt den Score nur einmal pro Schicht.
 * Bei Score < 0.90: Account SUSPENDED (temporär, SUSPENSION_DAYS) + offene Bewerbungen zurückgezogen + E-Mail an die Aushilfe.
 */
export async function registerNoShow(shiftId: string, now = new Date()) {
  const outcome = await prisma.$transaction(async (tx) => {
    const temp = await tx.temporaryEmployee.findUnique({ where: { shiftId } });
    if (!temp) throw notFound('Kein Match für diese Schicht');
    if (temp.clockedInAt) throw conflict('Freelancer hat eingecheckt – kein No-Show');
    if (now.getTime() < temp.validFrom.getTime() + NO_SHOW_GRACE_MINUTES * 60_000)
      throw conflict('Toleranzzeit noch nicht abgelaufen');

    // Atomarer Claim → nur ein Aufrufer bucht den No-Show
    const claim = await tx.temporaryEmployee.updateMany({
      where: { id: temp.id, noShowRecordedAt: null, clockedInAt: null },
      data: { noShowRecordedAt: now },
    });
    if (claim.count !== 1) return null;

    const f = await tx.freelancer.findUniqueOrThrow({ where: { id: temp.freelancerId } });
    const { score, suspend } = applyNoShowPenalty(f.reliabilityScore);
    const until = new Date(now.getTime() + SUSPENSION_DAYS * 86_400_000);
    await tx.freelancer.update({
      where: { id: f.id },
      data: { reliabilityScore: score, noShowCount: { increment: 1 }, ...(suspend && { accountStatus: 'SUSPENDED', suspendedUntil: until }) },
    });
    if (suspend) {
      await tx.shiftApplication.updateMany({ where: { freelancerId: f.id, status: 'PENDING' }, data: { status: 'WITHDRAWN', decidedAt: now } });
    }
    return { freelancerId: f.id, score, suspend, until };
  });
  if (!outcome) return { alreadyRecorded: true as const };
  if (outcome.suspend) notifySuspended(outcome.freelancerId, outcome.until);
  return { alreadyRecorded: false as const, reliabilityScore: outcome.score, suspended: outcome.suspend };
}

/**
 * Automatische No-Show-Erkennung (Worker, alle ~5 Min.) – NUR für Betriebe mit angebundenem Terminal (aktiver API-Schlüssel),
 * denn nur dort gilt „kein Check-in“ als verlässliches Signal. Sonst entscheidet der Wirt selbst (Schaltfläche in der Oberfläche).
 */
export async function sweepNoShows(now = new Date()) {
  const cutoff = new Date(now.getTime() - NO_SHOW_GRACE_MINUTES * 60_000);
  const due = await prisma.temporaryEmployee.findMany({
    where: { clockedInAt: null, noShowRecordedAt: null, validFrom: { lte: cutoff }, validUntil: { gt: now },
      restaurant: { apiKeys: { some: { revokedAt: null } } } },
    select: { shiftId: true },
  });
  for (const d of due) await registerNoShow(d.shiftId, now).catch(console.error);
  return due.length;
}

/** Erinnert Wirte ohne Terminal per E-Mail, die Anwesenheit zu bestätigen (20 Min. nach Schichtbeginn, einmalig). */
export async function remindAttendance(now = new Date()) {
  const due = await prisma.temporaryEmployee.findMany({
    where: { clockedInAt: null, noShowRecordedAt: null, attendanceReminderAt: null, validFrom: { lte: new Date(now.getTime() - 20 * 60_000) }, validUntil: { gt: now },
      restaurant: { apiKeys: { none: { revokedAt: null } } } },
    include: { freelancer: { select: { displayName: true } }, shift: { select: { role: true, startTime: true } },
      restaurant: { include: { members: { where: { role: { in: ['OWNER', 'MANAGER'] } }, include: { user: { select: { email: true } } } } } } },
  });
  for (const t of due) {
    const claim = await prisma.temporaryEmployee.updateMany({ where: { id: t.id, attendanceReminderAt: null }, data: { attendanceReminderAt: now } });
    if (claim.count !== 1) continue;
    for (const m of t.restaurant.members) await sendAttendanceReminder(m.user.email, t.freelancer.displayName, t.shift.role, t.shift.startTime);
  }
  return due.length;
}

/** Hebt abgelaufene Sperren auf (Bewährungs-Score). Wird bei jedem Freelancer-Zugriff geprüft. */
export async function liftExpiredSuspension(freelancerId: string, now = new Date()) {
  await prisma.freelancer.updateMany({
    where: { id: freelancerId, accountStatus: 'SUSPENDED', suspendedUntil: { lte: now } },
    data: { accountStatus: 'ACTIVE', suspendedUntil: null, reliabilityScore: PROBATION_SCORE },
  });
}
