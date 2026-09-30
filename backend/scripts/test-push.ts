/**
 * Testet den Push-Versand ohne echtes Gerät: ein lokaler HTTPS-Server gibt sich als Push-Dienst aus, die Nachricht wird
 * mit dem Schlüssel des „Geräts“ entschlüsselt. Benötigt DATABASE_URL, JWT_SECRET, SSN_ENCRYPTION_KEY und openssl.
 *   npx tsx scripts/test-push.ts
 */
import { createECDH, randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import https from 'https';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';
import webpush from 'web-push';

process.env.PUSH_ALLOW_ANY = '1'; // nur im Test: lokaler „Push-Dienst“ statt der echten Adressen
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // nur für dieses Testskript: selbstsigniertes Zertifikat des Test-Servers
const keys = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey;
const ece = createRequire(import.meta.url ?? __filename)('http_ece');
const prisma = new PrismaClient();
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : '  → ' + JSON.stringify(detail)}`); if (!ok) failed++; };

async function main() {
  const { pushToUser, pushToEmail } = await import('../src/services/push');
  const dir = mkdtempSync(join(tmpdir(), 'pushtest-'));
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  const received: Array<{ path: string; headers: Record<string, unknown>; body: Buffer }> = [];
  let status = 201;
  const server = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = req.url!.includes('gone') ? 410 : status; res.end(); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const user = await prisma.user.create({ data: { email: `push-${Date.now()}@smoketest.invalid`, emailVerifiedAt: new Date() } });
  const device = (path: string) => { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); const auth = randomBytes(16);
    return { ecdh, auth, endpoint: `https://localhost:${port}/push/${path}`, p256dh: ecdh.getPublicKey().toString('base64url'), authB64: auth.toString('base64url') }; };
  const d1 = device('ok'), d2 = device('gone'), d3 = device('flaky');
  for (const d of [d1, d2, d3]) await prisma.pushSubscription.create({ data: { userId: user.id, endpoint: d.endpoint, p256dh: d.p256dh, auth: d.authB64 } });

  try {
    status = 201;
    const n = await pushToUser(user.id, { title: 'Neue Bewerbung: Barkeeper', body: 'Öffne SmartShift Swap für Details.', url: '/app/', tag: 't1' });
    const r1 = received.find((r) => r.path.endsWith('/ok'))!;
    check('Push wurde an das Gerät ausgeliefert', !!r1 && n >= 1, n);
    check('verschlüsselt (aes128gcm) und mit VAPID-Signatur', r1?.headers['content-encoding'] === 'aes128gcm' && String(r1?.headers.authorization).startsWith('vapid t='), r1?.headers);
    const plain = JSON.parse(ece.decrypt(r1.body, { version: 'aes128gcm', privateKey: d1.ecdh, authSecret: d1.auth }).toString());
    check('Inhalt lässt sich mit dem Schlüssel des Geräts entschlüsseln', plain.title === 'Neue Bewerbung: Barkeeper' && plain.url === '/app/', plain);
    check('Abonnement „410 Gone“ wird automatisch entfernt', (await prisma.pushSubscription.count({ where: { endpoint: d2.endpoint } })) === 0);
    check('funktionierendes Abonnement bleibt, lastSentAt gesetzt', !!(await prisma.pushSubscription.findUnique({ where: { endpoint: d1.endpoint } }))?.lastSentAt);
    status = 500; received.length = 0;
    await pushToUser(user.id, { title: 'x' });
    check('bei Serverfehler (500) bleibt das Abonnement erhalten', (await prisma.pushSubscription.count({ where: { endpoint: d3.endpoint } })) === 1);
    status = 201;
    check('Versand über die E-Mail-Adresse funktioniert', (await pushToEmail(user.email, { title: 'y' })) >= 1);
    check('unbekannte Adresse → 0, kein Fehler', (await pushToEmail('gibtsnicht@smoketest.invalid', { title: 'y' })) === 0);
  } finally {
    await prisma.user.delete({ where: { id: user.id } }); server.close();
  }
}
main().catch((e) => { console.error(e); failed++; }).finally(async () => { await prisma.$disconnect(); console.log(failed ? `\n${failed} FEHLER` : '\nALLE TESTS BESTANDEN'); process.exit(failed ? 1 : 0); });
