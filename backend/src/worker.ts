import { validateConfig } from './config';
import { remindAttendance, sweepNoShows } from './services/reliability';
import { cleanupOldData, expireOpenShifts } from './services/maintenance';
import { remindSofortmeldung } from './services/sofortmeldung';
import { dispatchPendingWebhooks } from './services/webhooks';

validateConfig();

/** Hintergrund-Worker: No-Show-Erkennung (nur Betriebe mit Terminal) und Anwesenheits-Erinnerung (alle 5 Min.), Webhook-Zustellung/Retry (alle 30 Sek.). */
async function safe(name: string, fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) { console.error(`[worker] ${name} fehlgeschlagen`, e); }
}
setInterval(() => void safe('sweepNoShows', () => sweepNoShows()), 5 * 60_000);
setInterval(() => void safe('remindAttendance', () => remindAttendance()), 5 * 60_000);
setInterval(() => void safe('remindSofortmeldung', () => remindSofortmeldung()), 5 * 60_000);
setInterval(() => void safe('expireOpenShifts', () => expireOpenShifts()), 10 * 60_000);
setInterval(() => void safe('cleanupOldData', () => cleanupOldData()), 6 * 3600_000);
setInterval(() => void safe('dispatchPendingWebhooks', () => dispatchPendingWebhooks()), 30_000);
console.log('SmartShift Worker gestartet');
