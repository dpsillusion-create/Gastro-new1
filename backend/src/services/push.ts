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

/**
 * Der Server schickt Push-Nachrichten an die vom Gerät gemeldete Adresse. Damit niemand den Server zu Anfragen an interne
 * oder fremde Ziele verleiten kann (SSRF), sind nur die Adressen der bekannten Push-Dienste erlaubt.
 * Weitere Hosts: PUSH_EXTRA_HOSTS (kommagetrennt). Nur außerhalb der Produktion: PUSH_ALLOW_ANY=1 (für Tests).
 */
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let u: URL; try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false; // immer https, nie mit Zugangsdaten in der Adresse
  if (process.env.NODE_ENV !== 'production' && process.env.PUSH_ALLOW_ANY === '1') return true;
  if (u.port && u.port !== '443') return false;
  const h = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(':') || h === 'localhost') return false; // keine IP-Adressen/lokale Namen
  return PUSH_HOSTS.some((re) => re.test(h)) || (process.env.PUSH_EXTRA_HOSTS ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).includes(h);
}

export interface PushPayload { title: string; body?: string; url?: string; tag?: string }

/** Schickt eine Push-Nachricht an alle Geräte eines Nutzers. Fehler werden nie nach außen gereicht; tote Abonnements (404/410) werden gelöscht. */
export async function pushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled()) return 0;
  configure();
  const subs = (await prisma.pushSubscription.findMany({ where: { userId } })).filter((x) => isAllowedPushEndpoint(x.endpoint));
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
