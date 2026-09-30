import { createHmac } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db';

export const SOFORTMELDUNG_EVENT = 'trigger_sofortmeldung_generation';

/** Schreibt das Event in derselben Transaktion wie die Fachänderung (Transactional Outbox). */
export function enqueueEvent(tx: Tx, type: string, payload: Prisma.InputJsonObject) {
  return tx.webhookEvent.create({ data: { type, payload } });
}

/**
 * Stellt offene Events per HTTP-POST zu (HMAC-SHA256-Signatur im Header `X-Signature`).
 * Ziel-URL/Secret: WEBHOOK_URL / WEBHOOK_SECRET. Ohne URL bleibt das Event im Outbox (pollbar).
 * Mit Retry-Zähler; ein Worker ruft diese Funktion periodisch und direkt nach dem Accept auf.
 */
export async function dispatchPendingWebhooks(limit = 20) {
  const url = process.env.WEBHOOK_URL, secret = process.env.WEBHOOK_SECRET;
  if (!url || !secret) return 0;
  const events = await prisma.webhookEvent.findMany({
    where: { deliveredAt: null, attempts: { lt: 8 } }, orderBy: { createdAt: 'asc' }, take: limit,
  });
  let ok = 0;
  for (const e of events) {
    const body = JSON.stringify({ id: e.id, type: e.type, payload: e.payload, createdAt: e.createdAt });
    try {
      const res = await fetch(url, {
        method: 'POST', body, signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'x-event-type': e.type,
                   'x-signature': createHmac('sha256', secret).update(body).digest('hex') },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await prisma.webhookEvent.update({ where: { id: e.id }, data: { deliveredAt: new Date(), attempts: { increment: 1 } } });
      ok++;
    } catch {
      await prisma.webhookEvent.update({ where: { id: e.id }, data: { attempts: { increment: 1 } } });
    }
  }
  return ok;
}
