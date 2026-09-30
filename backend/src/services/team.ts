import { createHash, randomBytes } from 'crypto';
import { prisma } from '../db';
import { conflict, notFound } from '../errors';
import { deliver } from './notify';

const INVITE_DAYS = 7;
const MAX_PENDING = 10;
export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
const BASE = () => (process.env.PUBLIC_URL ?? 'https://jobs.gastroevolution.de').replace(/\/$/, '');

/** Lädt eine Person als Manager ein. Der Token wird nur per E-Mail verschickt; schlägt der Versand fehl, wird die Einladung wieder entfernt. */
export async function inviteManager(inviterId: string, restaurantId: string, emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  const [restaurant, inviter] = await Promise.all([
    prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { name: true } }),
    prisma.user.findUniqueOrThrow({ where: { id: inviterId }, select: { email: true } }),
  ]);
  if (await prisma.restaurantMember.findFirst({ where: { restaurantId, user: { email } } })) throw conflict('Diese Person gehört schon zum Team');
  const now = new Date();
  const pending = await prisma.teamInvitation.findMany({ where: { restaurantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } }, select: { email: true } });
  if (pending.some((p) => p.email === email)) throw conflict('Diese Person wurde bereits eingeladen');
  if (pending.length >= MAX_PENDING) throw conflict('Zu viele offene Einladungen – bitte erst einige widerrufen');
  const token = randomBytes(24).toString('base64url');
  const inv = await prisma.teamInvitation.create({ data: { restaurantId, email, tokenHash: hashToken(token), invitedById: inviterId, expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000) } });
  try {
    await deliver('EMAIL', email, `${inviter.email} hat Sie eingeladen, den Betrieb „${restaurant.name}“ auf SmartShift Swap als Manager mitzuverwalten (Bewerber bestätigen, Anwesenheit melden, bewerten).\n\nEinladung annehmen: ${BASE()}/app/?invite=${token}\n\nDer Link ist ${INVITE_DAYS} Tage gültig. Wenn Sie diese Einladung nicht erwarten, ignorieren Sie diese Nachricht.\n\n–\nGastroEvolution SmartShift Swap`,
      `Einladung: ${restaurant.name} auf SmartShift Swap`);
  } catch (e) { await prisma.teamInvitation.delete({ where: { id: inv.id } }); throw e; }
  return { id: inv.id, email, expiresAt: inv.expiresAt };
}

/** Gültige Einladung zu einem Token (nicht angenommen, nicht widerrufen, nicht abgelaufen). */
export async function findValidInvitation(token: string) {
  const inv = await prisma.teamInvitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { restaurant: { select: { name: true } } } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw notFound('Einladung ungültig oder abgelaufen');
  return inv;
}
