import { prisma } from '../db';

/** Offene Schichten, deren Beginn verstrichen ist, werden automatisch abgesagt (keine „ewig offenen“ Schichten); Bewerbungen darauf zurückgezogen. */
export async function expireOpenShifts(now = new Date()) {
  const stale = await prisma.marketplaceShift.findMany({ where: { status: 'OPEN', startTime: { lt: now } }, select: { id: true } });
  let n = 0;
  for (const s of stale) {
    const r = await prisma.marketplaceShift.updateMany({ where: { id: s.id, status: 'OPEN' }, data: { status: 'CANCELLED', version: { increment: 1 } } });
    if (r.count === 1) { n++; await prisma.shiftApplication.updateMany({ where: { shiftId: s.id, status: 'PENDING' }, data: { status: 'WITHDRAWN', decidedAt: now } }); }
  }
  return n;
}

/** Räumt Überholtes auf: alte Codes, zugestellte Webhook-Ereignisse, abgelaufene Einladungen. Protokoll und Meldedaten bleiben unberührt. */
export async function cleanupOldData(now = new Date()) {
  const day = 86_400_000;
  const [otp, hooks, invites] = await Promise.all([
    prisma.otpChallenge.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 2 * day) } } }),
    prisma.webhookEvent.deleteMany({ where: { deliveredAt: { not: null, lt: new Date(now.getTime() - 30 * day) } } }),
    prisma.teamInvitation.deleteMany({ where: { OR: [{ expiresAt: { lt: new Date(now.getTime() - 30 * day) } }, { revokedAt: { lt: new Date(now.getTime() - 30 * day) } }] } }),
  ]);
  return { otp: otp.count, webhooks: hooks.count, invitations: invites.count };
}
