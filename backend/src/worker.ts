import { sweepNoShows } from './services/reliability';
import { dispatchPendingWebhooks } from './services/webhooks';

/** Hintergrund-Worker: No-Show-Erkennung (alle 5 Min.) und Webhook-Zustellung/Retry (alle 30 Sek.). */
async function safe(name: string, fn: () => Promise<unknown>) {
  try { await fn(); } catch (e) { console.error(`[worker] ${name} fehlgeschlagen`, e); }
}
setInterval(() => void safe('sweepNoShows', () => sweepNoShows()), 5 * 60_000);
setInterval(() => void safe('dispatchPendingWebhooks', () => dispatchPendingWebhooks()), 30_000);
console.log('SmartShift Worker gestartet');
