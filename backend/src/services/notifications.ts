import { prisma } from '../db';
import { deliver } from './notify';

/**
 * E-Mail-Benachrichtigungen zu Bewerbungen, Zusagen usw. Sie laufen "fire and forget": ein Fehler beim Versand
 * (z. B. SMTP down) wird nur protokolliert und darf die eigentliche Aktion nie scheitern lassen.
 */
const BASE = () => (process.env.PUBLIC_URL ?? 'https://jobs.gastroevolution.de').replace(/\/$/, '');
const fmt = (d: Date) => d.toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const FOOTER = '\n\n–\nGastroEvolution SmartShift Swap\nDiese Nachricht wurde automatisch erzeugt.';

async function mail(to: string, subject: string, body: string) {
  try { await deliver('EMAIL', to, body + FOOTER, subject); } catch { /* bereits protokolliert */ }
}
const run = (p: Promise<unknown>) => { p.catch((e) => console.error('[notifications]', (e as Error).message)); };

// Drosselung: pro Schicht höchstens eine "Neue Bewerbung"-Mail alle 10 Minuten
const lastApplicationMail = new Map<string, number>();

/** Wirt (Inhaber/Manager): neue Bewerbung. */
export function notifyNewApplication(shiftId: string) {
  run((async () => {
    if (Date.now() - (lastApplicationMail.get(shiftId) ?? 0) < 10 * 60_000) return;
    lastApplicationMail.set(shiftId, Date.now());
    const s = await prisma.marketplaceShift.findUnique({ where: { id: shiftId }, include: { restaurant: { include: { members: { where: { role: { in: ['OWNER', 'MANAGER'] } }, include: { user: { select: { email: true } } } } } } } });
    if (!s) return;
    for (const m of s.restaurant.members)
      await mail(m.user.email, `Neue Bewerbung: ${s.role} am ${fmt(s.startTime)}`,
        `Für Ihre Schicht „${s.role}“ (${fmt(s.startTime)} – ${fmt(s.endTime)}) hat sich eine Aushilfe beworben.\n\nJetzt ansehen und bestätigen: ${BASE()}/app/`);
  })());
}

/** Aushilfe: Zusage – inkl. Adresse (erst jetzt). */
export function notifyAccepted(shiftId: string, freelancerId: string) {
  run((async () => {
    const [s, f] = await Promise.all([
      prisma.marketplaceShift.findUnique({ where: { id: shiftId }, include: { restaurant: true } }),
      prisma.freelancer.findUnique({ where: { id: freelancerId }, include: { user: { select: { email: true } } } }),
    ]);
    if (!s || !f) return;
    await mail(f.user.email, `Bestätigt: ${s.role} bei ${s.restaurant.name}`,
      `Gute Nachrichten, ${f.displayName}! ${s.restaurant.name} hat dich bestätigt.\n\n${s.role} · ${euro(s.hourlyRateCents)}/Std.\n${fmt(s.startTime)} – ${fmt(s.endTime)} Uhr\n${s.restaurant.street}, ${s.restaurant.zip} ${s.restaurant.city}\n\nBitte sei pünktlich und checke vor Ort am Zeiterfassungsterminal ein. Bei Nichterscheinen wird dein Konto gesperrt.\n\nDetails: ${BASE()}/jobs/`);
  })());
}

/** Aushilfen, die nicht zum Zug kamen bzw. deren Schicht zurückgezogen wurde. */
export function notifyNotSelected(shiftId: string, freelancerIds: string[], reason: 'FILLED' | 'CANCELLED') {
  run((async () => {
    const s = await prisma.marketplaceShift.findUnique({ where: { id: shiftId }, include: { restaurant: { select: { name: true } } } });
    if (!s || freelancerIds.length === 0) return;
    const users = await prisma.freelancer.findMany({ where: { id: { in: freelancerIds } }, include: { user: { select: { email: true } } } });
    for (const f of users)
      await mail(f.user.email, reason === 'FILLED' ? `Schicht besetzt: ${s.role} bei ${s.restaurant.name}` : `Schicht zurückgezogen: ${s.role} bei ${s.restaurant.name}`,
        reason === 'FILLED' ? `Leider wurde die Schicht „${s.role}“ (${fmt(s.startTime)}) anderweitig besetzt. Weitere Schichten findest du hier: ${BASE()}/jobs/`
          : `Der Betrieb hat die Schicht „${s.role}“ (${fmt(s.startTime)}) zurückgezogen. Weitere Schichten findest du hier: ${BASE()}/jobs/`);
  })());
}

/** Aushilfe: Sperre wegen Nichterscheinens. */
export function notifySuspended(freelancerId: string, until: Date) {
  run((async () => {
    const f = await prisma.freelancer.findUnique({ where: { id: freelancerId }, include: { user: { select: { email: true } } } });
    if (!f) return;
    await mail(f.user.email, 'Dein Konto wurde vorübergehend gesperrt',
      `Hallo ${f.displayName},\n\nzu einer bestätigten Schicht bist du nicht erschienen. Dein Konto ist deshalb bis ${until.toLocaleDateString('de-DE')} gesperrt.\nWenn das ein Irrtum war, antworte bitte auf diese Nachricht bzw. melde dich bei uns.`);
  })());
}

/** Wirt: Erinnerung, die Anwesenheit zu bestätigen. */
export async function sendAttendanceReminder(to: string, who: string, role: string, start: Date) {
  await mail(to, `Ist ${who} erschienen?`, `Ihre Schicht „${role}“ hat um ${fmt(start)} begonnen. Bitte bestätigen Sie, ob ${who} erschienen ist – sonst bleibt die Schicht offen und die Bewertung ist nicht möglich.\n\n${BASE()}/app/`);
}
