import webpush from 'web-push';
import { prisma } from '../db';

/**
 * Web-Push (VAPID). Aktiv nur, wenn VAPID_PUBLIC_KEY und VAPID_PRIVATE_KEY gesetzt sind (Schlüssel erzeugen: `npm run vapid`).
 * Die Nachrichten enthalten bewusst nur allgemeine Texte (erscheinen auf dem Sperrbildschirm) – Details stehen in der App.
 */
export const pushEnabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY ?? null;

let configured = false;
function configure() {
  if (configured) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? `mailto:${(process.env.MAIL_FROM ?? 'admin@gastroevolution.de').replace(/^.*<|>.*$/g, '')}`, process.env.VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);
  configured = true;
}

export interface PushPayload { title: string; body?: string; url?: string; tag?: string }

/** Schickt eine Push-Nachricht an alle Geräte eines Nutzers. Fehler werden nie nach außen gereicht; tote Abonnements (404/410) werden gelöscht. */
export async function pushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled()) return 0;
  configure();
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
      sent++; await prisma.pushSubscription.update({ where: { id: s.id }, data: { lastSentAt: new Date() } }).catch(() => {});
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      else console.error('[push]', code ?? (e as Error).message);
    }
  }));
  return sent;
}

/** Wie pushToUser, adressiert über die E-Mail-Adresse (so nutzen die bestehenden E-Mail-Benachrichtigungen denselben Weg). */
export async function pushToEmail(email: string, payload: PushPayload) {
  if (!pushEnabled()) return 0;
  const u = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return u ? pushToUser(u.id, payload) : 0;
}
