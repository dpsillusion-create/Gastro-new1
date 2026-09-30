/**
 * End-to-End-Durchlauf gegen eine echte Datenbank + laufende API.
 * Nutzung:  BASE_URL=http://127.0.0.1:3100 npx tsx scripts/smoke.ts
 * Benötigt dieselben Umgebungsvariablen wie der Server (DATABASE_URL, JWT_SECRET, SSN_ENCRYPTION_KEY).
 * Legt nur eigene Testdaten an (E-Mail-Endung @smoketest.invalid, erfundene Nummern) und löscht sie am Ende.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { encrypt } from '../src/services/crypto';
import { totpCode } from '../src/services/totp';
import { remindAttendance, sweepNoShows } from '../src/services/reliability';
import { remindSofortmeldung } from '../src/services/sofortmeldung';
import { readFileSync } from 'fs';

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const token = (sub: string) => jwt.sign({ sub }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '10m' });
let failed = 0;
// E-Mails, die dieser Prozess selbst "verschickt" (Protokoll-Modus), zusätzlich zum Serverprotokoll auswerten
const localMails: string[] = [];
const origWarn = console.warn; console.warn = (...a: unknown[]) => { localMails.push(a.join(' ')); origWarn(...a); };
/** Prüft, ob eine E-Mail „verschickt“ wurde (Protokoll-Modus): Empfänger, Betreff-Teil und optional ein Stück des Textes. */
async function mailSent(to: string, subjectPart: string, bodyPart?: string) {
  const match = (log: string) => log.split('[NOTIFY_MODE=log]').some((m) => m.includes(`EMAIL an ${to} [`) && m.includes(subjectPart) && (!bodyPart || m.includes(bodyPart)));
  for (let i = 0; i < 15; i++) {
    if (match(localMails.join('\n'))) return true;
    try { if (match(readFileSync(process.env.SERVER_LOG ?? '/tmp/srv.log', 'utf8'))) return true; } catch { return false; }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function api(method: string, path: string, user: string | null, body?: unknown) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(user ? { authorization: `Bearer ${token(user)}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '✔' : '✘'} ${name}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

async function cleanup() {
  const users = await prisma.user.findMany({ where: { email: { endsWith: '@smoketest.invalid' } }, select: { id: true } });
  const ids = users.map(u => u.id);
  const shifts = await prisma.marketplaceShift.findMany({ where: { createdById: { in: ids } }, select: { id: true } });
  const sid = shifts.map(s => s.id);
  const temps = await prisma.temporaryEmployee.findMany({ where: { shiftId: { in: sid } }, select: { id: true } });
  const tid = temps.map(t => t.id);
  await prisma.immediateNotification.deleteMany({ where: { temporaryEmployeeId: { in: tid } } });
  await prisma.rosterEntry.deleteMany({ where: { temporaryEmployeeId: { in: tid } } });
  await prisma.temporaryEmployee.deleteMany({ where: { id: { in: tid } } });
  for (const id of sid) await prisma.webhookEvent.deleteMany({ where: { payload: { path: ['shiftId'], equals: id } } });
  await prisma.marketplaceShift.deleteMany({ where: { id: { in: sid } } });
  await prisma.restaurant.deleteMany({ where: { name: 'Smoketest Restaurant' } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  await cleanup();
  const mk = (n: string) => prisma.user.create({ data: { email: `${n}@smoketest.invalid` } });
  const [owner, manager, stranger, fu] = await Promise.all(['owner', 'manager', 'stranger', 'freelancer'].map(mk));
  const restaurant = await prisma.restaurant.create({ data: {
    name: 'Smoketest Restaurant', street: 'Teststr. 1', zip: '20095', city: 'Hamburg',
    latitude: 53.5511, longitude: 9.9937, employerBetriebsnummer: '12345678',
  } });
  await prisma.restaurantMember.createMany({ data: [
    { userId: owner!.id, restaurantId: restaurant.id, role: 'OWNER' },
    { userId: manager!.id, restaurantId: restaurant.id, role: 'MANAGER' },
  ] });
  const freelancer = await prisma.freelancer.create({ data: {
    userId: fu!.id, displayName: 'Test Freelancer', verified: true, verifiedSkills: ['BAR'],
    homeLatitude: 53.58, homeLongitude: 10.0, // ≈ 3–4 km entfernt
    socialSecurityNumberEnc: encrypt('PLACEHOLDER'), taxIdEnc: encrypt('PLACEHOLDER'), birthDate: new Date('1949-06-07'),
  } });

  const start = new Date(Date.now() + 3 * 3600_000), end = new Date(start.getTime() + 8 * 3600_000);
  const good = { restaurantId: restaurant.id, role: 'Barkeeper', requiredSkill: 'BAR', requirements: 'Cocktailbar-Erfahrung',
    hourlyRateCents: 1900, startTime: start.toISOString(), endTime: end.toISOString(), activityKey: '123456789' };

  console.log('— POST /shifts');
  check('ohne Login → 401', (await api('POST', '/api/v1/marketplace/shifts', null, good)).status === 401);
  const r403a = await api('POST', '/api/v1/marketplace/shifts', stranger!.id, good);
  check('fremder Nutzer (ID-Spoofing) → 403', r403a.status === 403, r403a);
  const r403b = await api('POST', '/api/v1/marketplace/shifts', manager!.id, good);
  check('Manager (nicht Inhaber) → 403', r403b.status === 403, r403b);
  const r403c = await api('POST', '/api/v1/marketplace/shifts', owner!.id, { ...good, restaurantId: '00000000-0000-4000-8000-000000000000' });
  check('nicht existierendes Restaurant → 403 (kein Existenz-Leak)', r403c.status === 403, r403c);
  for (const [name, patch] of [
    ['Stundensatz unter Mindestlohn', { hourlyRateCents: 1200 }],
    ['Start in der Vergangenheit', { startTime: new Date(Date.now() - 3600_000).toISOString() }],
    ['Ende vor Start', { endTime: new Date(start.getTime() - 1000).toISOString() }],
    ['unbekannte Rolle', { role: 'Pirat' }],
    ['unbekanntes Feld', { status: 'MATCHED' }],
  ] as const) {
    const r = await api('POST', '/api/v1/marketplace/shifts', owner!.id, { ...good, ...patch });
    check(`${name} → 400`, r.status === 400, r);
  }
  const created = await api('POST', '/api/v1/marketplace/shifts', owner!.id, good);
  check('Inhaber → 201, Status OPEN', created.status === 201 && created.json.status === 'OPEN', created);
  const shiftId: string = created.json.id;

  console.log('— Registrierung / Zwei-Faktor (E-Mail-Code)');
  const CODE = '123456'; // = OTP_TEST_CODE des Testservers
  const reg = { email: 'neu@smoketest.invalid', phone: '0171 1000001', password: 'ein-langes-passwort', restaurantName: 'Smoketest Restaurant', street: 'Teststr. 2',
    zip: '20095', city: 'Hamburg', betriebsnummer: '12345678', latitude: 53.55, longitude: 9.99, acceptTerms: true };
  check('Registrierung ohne Zustimmung zu den Bedingungen → 400', (await api('POST', '/api/v1/auth/register', null, { ...reg, acceptTerms: false })).status === 400);
  check('Registrierung mit kurzem Passwort → 400', (await api('POST', '/api/v1/auth/register', null, { ...reg, password: 'kurz' })).status === 400);
  check('ungültige Handynummer → 400', (await api('POST', '/api/v1/auth/register', null, { ...reg, phone: '12345' })).status === 400);
  const rr = await api('POST', '/api/v1/auth/register', null, reg);
  check('Registrierung → 201, noch KEIN Sitzungstoken', rr.status === 201 && !!rr.json.verificationToken && !rr.json.token, rr);
  const regUser = await prisma.user.findUniqueOrThrow({ where: { email: reg.email } });
  check('Zustimmung mit Zeitpunkt und Textversion gespeichert', !!regUser.termsAcceptedAt && !!regUser.termsVersion, regUser.termsVersion);
  check('Zwischen-Token ist keine Sitzung → 401', (await fetch(BASE + '/api/v1/auth/me', { headers: { authorization: `Bearer ${rr.json.verificationToken}` } })).status === 401);
  check('doppelte E-Mail → 409', (await api('POST', '/api/v1/auth/register', null, { ...reg, phone: '0171 1000002' })).status === 409);
  const nv = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('Login vor E-Mail-Bestätigung → 403 NOT_VERIFIED', nv.status === 403 && nv.json?.error === 'NOT_VERIFIED', nv);
  check('falscher E-Mail-Code → 400', (await api('POST', '/api/v1/auth/verify', null, { verificationToken: rr.json.verificationToken, emailCode: '000000' })).status === 400);
  const vr = await api('POST', '/api/v1/auth/verify', null, { verificationToken: rr.json.verificationToken, emailCode: CODE });
  check('richtiger E-Mail-Code → Sitzungstoken', vr.status === 200 && !!vr.json.token, vr);
  check('Login falsches Passwort → 401', (await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: 'falsch-falsch-falsch' })).status === 401);
  const l1 = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('Login Schritt 1 → E-Mail-Code verlangt, kein Token', l1.status === 200 && l1.json.twoFactor === 'email' && !l1.json.token, l1);
  check('Login mit falschem Code → 400', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: l1.json.challengeToken, code: '111111' })).status === 400);
  const li = await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: l1.json.challengeToken, code: CODE });
  check('Login Schritt 2 → 200 + Token', li.status === 200 && !!li.json.token, li);
  check('Code nur einmal verwendbar', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: l1.json.challengeToken, code: CODE })).status === 400);
  const authed = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${li.json.token}` }, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  const me = await authed('GET', '/api/v1/auth/me');
  check('/me liefert Restaurant als OWNER', me.json?.restaurants?.[0]?.role === 'OWNER', me);
  const own = await authed('POST', '/api/v1/marketplace/shifts', { ...good, restaurantId: me.json.restaurants[0].id });
  check('neu registrierter Wirt kann Schicht ausschreiben → 201', own.status === 201, own);
  const mine = await authed('GET', '/api/v1/marketplace/my-shifts');
  check('/my-shifts zeigt die Schicht', mine.json?.length === 1, mine);
  check('Schicht zurückziehen → 204', (await authed('POST', `/api/v1/marketplace/shifts/${own.json.id}/cancel`)).status === 204);
  check('fremde Restaurant-ID mit eigenem Token → 403', (await authed('POST', '/api/v1/marketplace/shifts', good)).status === 403);

  console.log('— Authenticator-App (TOTP)');
  const step = () => Math.floor(Date.now() / 30_000);
  check('Einrichtung ohne Login → 401', (await api('POST', '/api/v1/auth/totp/setup', null, {})).status === 401);
  const su = await authed('POST', '/api/v1/auth/totp/setup', {});
  check('Einrichtung liefert Secret + QR-Code', su.status === 200 && /^[A-Z2-7]{32}$/.test(su.json.secret) && su.json.qr.startsWith('data:image/png;base64,') && su.json.otpauthUri.startsWith('otpauth://totp/'), { ...su, json: null });
  const secret: string = su.json.secret;
  const dbUser = await prisma.user.findUniqueOrThrow({ where: { email: reg.email } });
  check('Secret liegt verschlüsselt in der Datenbank', !!dbUser.totpSecretEnc && !dbUser.totpSecretEnc.includes(secret), null);
  check('Aktivieren mit falschem Code → 400', (await authed('POST', '/api/v1/auth/totp/enable', { code: '000000' })).status === 400);
  check('Aktivieren mit richtigem Code → 204', (await authed('POST', '/api/v1/auth/totp/enable', { code: totpCode(secret, step()) })).status === 204);
  check('/me zeigt totpEnabled', (await authed('GET', '/api/v1/auth/me')).json?.totpEnabled === true);
  const t1 = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('Login verlangt jetzt Code aus der App', t1.json?.twoFactor === 'totp', t1);
  check('falscher App-Code → 400', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: t1.json.challengeToken, code: '000000' })).status === 400);
  const good1 = totpCode(secret, step() + 1); // nächster Schritt (im Toleranzfenster) – der aktuelle wurde beim Aktivieren verbraucht
  check('richtiger App-Code → 200', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: t1.json.challengeToken, code: good1 })).status === 200);
  const t2 = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('derselbe App-Code ein zweites Mal → 400 (Replay-Schutz)', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: t2.json.challengeToken, code: good1 })).status === 400);
  check('Ersatz: E-Mail-Code statt App → 204 + Login 200', (await api('POST', '/api/v1/auth/resend', null, { token: t2.json.challengeToken, purpose: 'login' })).status === 204
    && (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: t2.json.challengeToken, code: CODE })).status === 200);
  await prisma.user.update({ where: { id: dbUser.id }, data: { totpLastStep: step() - 5 } });
  check('Deaktivieren mit falschem Passwort → 401', (await authed('POST', '/api/v1/auth/totp/disable', { password: 'falsch-falsch-falsch', code: totpCode(secret, step()) })).status === 401);
  check('Deaktivieren mit Passwort + Code → 204', (await authed('POST', '/api/v1/auth/totp/disable', { password: reg.password, code: totpCode(secret, step()) })).status === 204);
  const t3 = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('danach wieder E-Mail-Code als zweiter Faktor', t3.json?.twoFactor === 'email', t3);
  console.log('— Passwort vergessen');
  check('unbekannte Adresse → trotzdem 204 (kein Hinweis auf Existenz)', (await api('POST', '/api/v1/auth/password/forgot', null, { email: 'gibtsnicht@smoketest.invalid' })).status === 204);
  check('bekannte Adresse → 204', (await api('POST', '/api/v1/auth/password/forgot', null, { email: reg.email })).status === 204);
  check('falscher Reset-Code → 400', (await api('POST', '/api/v1/auth/password/reset', null, { email: reg.email, code: '000000', newPassword: 'neues-langes-passwort' })).status === 400);
  check('zu kurzes neues Passwort → 400', (await api('POST', '/api/v1/auth/password/reset', null, { email: reg.email, code: CODE, newPassword: 'kurz' })).status === 400);
  check('richtiger Code → Passwort geändert (204)', (await api('POST', '/api/v1/auth/password/reset', null, { email: reg.email, code: CODE, newPassword: 'neues-langes-passwort' })).status === 204);
  check('altes Passwort gilt nicht mehr → 401', (await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password })).status === 401);
  check('neues Passwort funktioniert', (await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: 'neues-langes-passwort' })).json?.twoFactor === 'email');
  reg.password = 'neues-langes-passwort';
  // Sperre nach Fehlversuchen
  const su2 = await authed('POST', '/api/v1/auth/totp/setup', {});
  await authed('POST', '/api/v1/auth/totp/enable', { code: totpCode(su2.json.secret, step()) });
  const t4 = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  for (let i = 0; i < 5; i++) await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: t4.json.challengeToken, code: '000000' });
  const locked = await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: t4.json.challengeToken, code: totpCode(su2.json.secret, step() + 1) });
  check('nach 5 Fehlversuchen gesperrt → 429', locked.status === 429, locked);

  console.log('— Freelancer-Flow');
  const early = await api('POST', `/api/v1/marketplace/shifts/${shiftId}/apply`, fu!.id);
  check('Bewerbung ohne validierte Pflichtangaben → 403', early.status === 403, early);
  const bad = await api('PUT', '/api/v1/freelancers/me/compliance', fu!.id, { socialSecurityNumber: '15070649C104', taxId: '86095742719', birthDate: '1949-06-07' });
  check('ungültige SV-Nummer → 400', bad.status === 400, bad);
  const ok = await api('PUT', '/api/v1/freelancers/me/compliance', fu!.id, { socialSecurityNumber: '15070649C103', taxId: '86095742719', birthDate: '1949-06-07' });
  check('gültige Pflichtangaben → 204', ok.status === 204, ok);
  const search = await api('GET', '/api/v1/marketplace/search?radiusKm=20', fu!.id);
  check('Umkreissuche findet Schicht', search.status === 200 && search.json.shifts.some((s: { id: string }) => s.id === shiftId), search);
  check('Distanz plausibel (< 10 km)', search.json?.shifts?.[0]?.distanceKm < 10, search.json?.shifts?.[0]);
  const apply = await api('POST', `/api/v1/marketplace/shifts/${shiftId}/apply`, fu!.id);
  check('Bewerbung → 201', apply.status === 201, apply);
  check('Bewerbung idempotent', (await api('POST', `/api/v1/marketplace/shifts/${shiftId}/apply`, fu!.id)).status === 201);

  console.log('— accept');
  check('fremder Nutzer → 403', (await api('POST', `/api/v1/marketplace/shifts/${shiftId}/accept`, stranger!.id, { freelancerId: freelancer.id })).status === 403);
  const acc = await api('POST', `/api/v1/marketplace/shifts/${shiftId}/accept`, owner!.id, { freelancerId: freelancer.id });
  check('Inhaber bestätigt → 200 MATCHED', acc.status === 200 && acc.json.status === 'MATCHED', acc);
  check('zweites accept → 4xx', (await api('POST', `/api/v1/marketplace/shifts/${shiftId}/accept`, owner!.id, { freelancerId: freelancer.id })).status >= 400);
  const temp = await prisma.temporaryEmployee.findUnique({ where: { shiftId }, include: { rosterEntry: true, immediateNotification: true } });
  check('temporärer Mitarbeiter + Dienstplan-Eintrag angelegt', !!temp?.rosterEntry, temp);
  check('Sofortmeldung READY', temp?.immediateNotification?.status === 'READY', temp?.immediateNotification);
  check('Webhook-Event trigger_sofortmeldung_generation in Outbox',
    (await prisma.webhookEvent.count({ where: { type: 'trigger_sofortmeldung_generation', payload: { path: ['shiftId'], equals: shiftId } } })) === 1);
  const exp = await api('GET', `/api/v1/marketplace/shifts/${shiftId}/sofortmeldung-export`, owner!.id);
  check('DEÜV-Export enthält SV-Nummer', exp.json?.data?.versicherungsnummer === '15070649C103' && exp.json?.missingFields?.length === 0, exp);
  check('Export für Fremde → 403', (await api('GET', `/api/v1/marketplace/shifts/${shiftId}/sofortmeldung-export`, stranger!.id)).status === 403);

  console.log('— Aushilfe registriert sich selbst');
  const freg = { email: 'aushilfe@smoketest.invalid', phone: '+49 171 2000001', password: 'ein-langes-passwort', displayName: 'Selbst Registriert', zip: '20359', city: 'Hamburg',
    skills: ['BAR'], birthDate: '1949-06-07', socialSecurityNumber: '15070649C103', taxId: '86095742719', privacyConsent: true };
  check('ohne Einwilligung → 400', (await api('POST', '/api/v1/freelancers/register', null, { ...freg, privacyConsent: false })).status === 400);
  check('ungültige Steuer-ID → 400', (await api('POST', '/api/v1/freelancers/register', null, { ...freg, taxId: '86095742710' })).status === 400);
  const fr0 = await api('POST', '/api/v1/freelancers/register', null, freg);
  check('Registrierung → 201 (Code per E-Mail)', fr0.status === 201 && !!fr0.json.verificationToken, fr0);
  const fr = await api('POST', '/api/v1/auth/verify', null, { verificationToken: fr0.json.verificationToken, emailCode: CODE });
  check('E-Mail-Code → Sitzung', fr.status === 200 && !!fr.json.token, fr);
  const fauth = async (m: string, p: string, b?: unknown) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${fr.json.token}` }, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  const prof = await fauth('GET', '/api/v1/freelancers/me');
  check('Profil: noch nicht freigeschaltet, Skills angegeben', prof.json?.verified === false && prof.json?.claimedSkills?.[0] === 'BAR' && prof.json?.hygiene === null, prof);
  check('Suche ohne Hygienenachweis → 403', (await fauth('GET', '/api/v1/marketplace/search')).status === 403);

  console.log('— Hygienenachweis');
  const png = (await import('fs')).readFileSync('public/jobs/icon-192.png').toString('base64');
  const issued = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  check('Textdatei statt Bild → 400', (await fauth('PUT', '/api/v1/freelancers/me/hygiene-certificate', { file: Buffer.from('das ist kein Bild '.repeat(20)).toString('base64'), issuedOn: issued })).status === 400);
  check('Ausstellungsdatum in der Zukunft → 400', (await fauth('PUT', '/api/v1/freelancers/me/hygiene-certificate', { file: png, issuedOn: '2999-01-01' })).status === 400);
  check('Nachweis hochladen → 204', (await fauth('PUT', '/api/v1/freelancers/me/hygiene-certificate', { file: png, issuedOn: issued })).status === 204);
  const prof2 = await fauth('GET', '/api/v1/freelancers/me');
  check('automatisch freigeschaltet, Skills übernommen', prof2.json?.verified === true && prof2.json?.verifiedSkills?.[0] === 'BAR' && !!prof2.json?.hygiene, prof2);
  const dbCert = await prisma.hygieneCertificate.findFirstOrThrow({ where: { freelancer: { user: { email: freg.email } } } });
  check('Dokument liegt verschlüsselt in der Datenbank', !Buffer.from(dbCert.dataEnc).includes(Buffer.from(png, 'base64').subarray(0, 16)), null);
  const shift2 = await api('POST', '/api/v1/marketplace/shifts', owner!.id, { ...good, startTime: new Date(Date.now() + 30 * 3600_000).toISOString(), endTime: new Date(Date.now() + 38 * 3600_000).toISOString() });
  const s2 = await fauth('GET', '/api/v1/marketplace/search');
  check('nach Verifizierung: Schicht in der Suche', s2.status === 200 && s2.json.shifts.some((x: { id: string }) => x.id === shift2.json.id), s2);
  check('Bewerben → 201', (await fauth('POST', `/api/v1/marketplace/shifts/${shift2.json.id}/apply`)).status === 201);
  check('E-Mail an den Wirt: neue Bewerbung', await mailSent('owner@smoketest.invalid', 'Neue Bewerbung'));
  const apps1 = await fauth('GET', '/api/v1/freelancers/me/applications');
  check('Bewerbung PENDING, Straße noch verborgen', apps1.json?.[0]?.status === 'PENDING' && apps1.json[0].shift.restaurant.street === undefined, apps1);
  check('Zurückziehen → 204', (await fauth('POST', `/api/v1/marketplace/shifts/${shift2.json.id}/withdraw`)).status === 204);
  check('nach Zurückziehen nicht mehr in Bewerbungen', (await fauth('GET', '/api/v1/freelancers/me/applications')).json?.length === 0);
  check('erneut bewerben → 201', (await fauth('POST', `/api/v1/marketplace/shifts/${shift2.json.id}/apply`)).status === 201);
  const fid = (await prisma.freelancer.findFirstOrThrow({ where: { user: { email: freg.email } } })).id;
  const lst = await api('GET', `/api/v1/marketplace/shifts/${shift2.json.id}/applications`, owner!.id);
  check('Wirt sieht Hygiene-Datum der Bewerberin', lst.json?.[0]?.hygieneIssuedOn?.startsWith(issued), lst);
  check('Dokument vor der Zusage NICHT abrufbar → 403', (await fetch(`${BASE}/api/v1/marketplace/shifts/${shift2.json.id}/hygiene-certificate`, { headers: { authorization: `Bearer ${token(owner!.id)}` } })).status === 403);
  check('Wirt bestätigt → 200', (await api('POST', `/api/v1/marketplace/shifts/${shift2.json.id}/accept`, owner!.id, { freelancerId: fid })).status === 200);
  check('E-Mail an die Aushilfe: Bestätigt (mit Adresse)', await mailSent(freg.email, 'Bestätigt: Barkeeper'));
  const dl = await fetch(`${BASE}/api/v1/marketplace/shifts/${shift2.json.id}/hygiene-certificate`, { headers: { authorization: `Bearer ${token(owner!.id)}` } });
  check('nach Zusage: Dokument abrufbar (PNG, unverändert)', dl.status === 200 && dl.headers.get('content-type') === 'image/png' && Buffer.from(await dl.arrayBuffer()).equals(Buffer.from(png, 'base64')));
  check('Dokument für Fremde → 403', (await fetch(`${BASE}/api/v1/marketplace/shifts/${shift2.json.id}/hygiene-certificate`, { headers: { authorization: `Bearer ${token(stranger!.id)}` } })).status === 403);
  const apps2 = await fauth('GET', '/api/v1/freelancers/me/applications');
  check('nach Bestätigung: ACCEPTED mit Adresse', apps2.json?.[0]?.status === 'ACCEPTED' && apps2.json[0].shift.restaurant.street === 'Teststr. 1', apps2);

  console.log('— Anwesenheit, Abschluss und Bewertung');
  const att = (id: string, status: string) => api('POST', `/api/v1/marketplace/shifts/${id}/attendance`, owner!.id, { status });
  const done = (id: string, rating: number, user = owner!.id) => api('POST', `/api/v1/marketplace/shifts/${id}/complete`, user, { rating });
  check('Einchecken zu früh → 409', (await att(shift2.json.id, 'PRESENT')).status === 409);
  check('Abschluss ohne Anwesenheit/vor Ende → 409', (await done(shift2.json.id, 5)).status === 409);
  const past = (mins: number, len: number) => ({ startTime: new Date(Date.now() - mins * 60_000), endTime: new Date(Date.now() - (mins - len) * 60_000) });
  const movePast = async (id: string, mins: number, len: number) => {
    const t = past(mins, len);
    await prisma.marketplaceShift.update({ where: { id }, data: t });
    await prisma.temporaryEmployee.update({ where: { shiftId: id }, data: { validFrom: t.startTime, validUntil: t.endTime } });
  };
  await movePast(shift2.json.id, 180, 120); // vor 3 h begonnen, vor 1 h beendet
  check('Fremder Nutzer kann nicht einchecken → 403', (await api('POST', `/api/v1/marketplace/shifts/${shift2.json.id}/attendance`, stranger!.id, { status: 'PRESENT' })).status === 403);
  check('Abschluss ohne Anwesenheit → 409', (await done(shift2.json.id, 5)).status === 409);
  check('Ist erschienen → 204', (await att(shift2.json.id, 'PRESENT')).status === 204);
  check('Nichterscheinen nach Einchecken → 409', (await att(shift2.json.id, 'NO_SHOW')).status === 409);
  check('Bewertung 6 → 400', (await done(shift2.json.id, 6)).status === 400);
  check('Bewertung durch Fremde → 403', (await done(shift2.json.id, 5, stranger!.id)).status === 403);
  check('Abschluss mit 4 Sternen → 204', (await done(shift2.json.id, 4)).status === 204);
  check('doppelte Bewertung → 409', (await done(shift2.json.id, 1)).status === 409);
  const after = await fauth('GET', '/api/v1/freelancers/me');
  check('Aushilfe hat Bewertung 4.0 (1)', after.json?.rating === 4 && after.json?.ratingCount === 1, after.json);

  console.log('— No-Show');
  await movePast(shiftId, 30, 480); // vor 30 Min. begonnen, kein Check-in
  const ns0 = await sweepNoShows();
  check('Worker sperrt NICHT automatisch, solange der Betrieb kein Terminal angebunden hat', ns0 === 0 && (await prisma.freelancer.findUniqueOrThrow({ where: { id: (await prisma.freelancer.findFirstOrThrow({ where: { userId: fu!.id } })).id } })).accountStatus === 'ACTIVE');
  await remindAttendance();
  check('E-Mail-Erinnerung an den Wirt: Ist … erschienen?', await mailSent('owner@smoketest.invalid', 'erschienen?'));
  const ns = await att(shiftId, 'NO_SHOW');
  check('No-Show senkt Score auf 0.75 und sperrt', ns.status === 200 && ns.json.reliabilityScore === 0.75 && ns.json.suspended, ns);
  check('No-Show idempotent', (await att(shiftId, 'NO_SHOW')).json?.alreadyRecorded === true);
  check('gesperrter Freelancer → 403', (await api('GET', '/api/v1/marketplace/search', fu!.id)).status === 403);
  check('E-Mail an die Aushilfe: Konto gesperrt', await mailSent('freelancer@smoketest.invalid', 'gesperrt'));

  console.log('— API-Schlüssel und Terminal-Schnittstelle');
  const rid = (await prisma.restaurant.findFirstOrThrow({ where: { name: 'Smoketest Restaurant', members: { some: { userId: owner!.id } } } })).id;
  check('Schlüssel anlegen: Fremde → 403', (await api('POST', `/api/v1/restaurants/${rid}/api-keys`, stranger!.id, { name: 'Terminal' })).status === 403);
  check('Schlüssel anlegen: Manager (nicht Inhaber) → 403', (await api('POST', `/api/v1/restaurants/${rid}/api-keys`, manager!.id, { name: 'Terminal' })).status === 403);
  const k = await api('POST', `/api/v1/restaurants/${rid}/api-keys`, owner!.id, { name: 'Terminal Küche' });
  check('Inhaber legt Schlüssel an → 201, Klartext einmalig', k.status === 201 && String(k.json.key).startsWith('ge_'), { ...k, json: null });
  const kl = await api('GET', `/api/v1/restaurants/${rid}/api-keys`, owner!.id);
  check('Liste zeigt nur Kennung, nie den Schlüssel', kl.json?.length === 1 && !JSON.stringify(kl.json).includes(k.json.key) && kl.json[0].prefix === k.json.key.slice(0, 8), kl.json);
  const dbKey = await prisma.restaurantApiKey.findFirstOrThrow({ where: { restaurantId: rid } });
  check('in der Datenbank nur der Hash', dbKey.keyHash !== k.json.key && dbKey.keyHash.length === 64, null);
  const ig = async (m: string, p: string, key: string | null, b?: unknown) => {
    const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
    const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
  };
  check('Terminal ohne Schlüssel → 401', (await ig('GET', '/api/v1/integrations/shifts', null)).status === 401);
  check('falscher Schlüssel → 401', (await ig('GET', '/api/v1/integrations/shifts', 'ge_falsch')).status === 401);
  check('API-Schlüssel gilt nicht für die normale API → 401', (await ig('GET', '/api/v1/marketplace/my-shifts', k.json.key)).status === 401);
  // Aushilfe f3 mit Schicht in 10 Minuten
  const mkF = async (n: string) => {
    const u = await prisma.user.create({ data: { email: `${n}@smoketest.invalid`, emailVerifiedAt: new Date() } });
    return prisma.freelancer.create({ data: { userId: u.id, displayName: n, verified: true, verifiedSkills: ['BAR'], claimedSkills: ['BAR'], homeLatitude: 53.55, homeLongitude: 9.99,
      socialSecurityNumberEnc: encrypt('15070649C103'), taxIdEnc: encrypt('86095742719'), birthDate: new Date('1949-06-07'), complianceValidatedAt: new Date() } });
  };
  const f3 = await mkF('terminal-aushilfe');
  const s3 = await api('POST', '/api/v1/marketplace/shifts', owner!.id, { ...good, startTime: new Date(Date.now() + 10 * 60_000).toISOString(), endTime: new Date(Date.now() + 8 * 3600_000).toISOString() });
  await prisma.shiftApplication.create({ data: { shiftId: s3.json.id, freelancerId: f3.id } });
  check('Wirt bestätigt f3 → 200', (await api('POST', `/api/v1/marketplace/shifts/${s3.json.id}/accept`, owner!.id, { freelancerId: f3.id })).status === 200);
  const list = await ig('GET', '/api/v1/integrations/shifts', k.json.key);
  check('Dienstplan-Abgleich liefert die bestätigte Schicht, ohne SV-Daten', list.status === 200 && list.json.some((x: { id: string; temporaryEmployee: { name: string } }) => x.id === s3.json.id && x.temporaryEmployee.name === 'terminal-aushilfe') && !JSON.stringify(list.json).includes('15070649'), list.json);
  check('Check-in für Schicht eines anderen Betriebs → 404', (await ig('POST', '/api/v1/integrations/clock-in', k.json.key, { shiftId: (await prisma.marketplaceShift.findFirstOrThrow({ where: { restaurantId: { not: rid } } })).id })).status === 404);
  check('Terminal meldet Check-in → 204', (await ig('POST', '/api/v1/integrations/clock-in', k.json.key, { shiftId: s3.json.id })).status === 204);
  check('zweiter Check-in → 409', (await ig('POST', '/api/v1/integrations/clock-in', k.json.key, { shiftId: s3.json.id })).status === 409);
  check('Check-in ist im Abgleich sichtbar', !!(await ig('GET', '/api/v1/integrations/shifts', k.json.key)).json.find((x: { id: string }) => x.id === s3.json.id)?.temporaryEmployee?.clockedInAt);
  // Auto-No-Show mit Terminal: f4, Schicht vor 30 Min. begonnen, kein Check-in
  const f4 = await mkF('nicht-erschienen');
  const s4 = await api('POST', '/api/v1/marketplace/shifts', owner!.id, { ...good, startTime: new Date(Date.now() + 3 * 3600_000).toISOString(), endTime: new Date(Date.now() + 11 * 3600_000).toISOString() });
  await prisma.shiftApplication.create({ data: { shiftId: s4.json.id, freelancerId: f4.id } });
  await api('POST', `/api/v1/marketplace/shifts/${s4.json.id}/accept`, owner!.id, { freelancerId: f4.id });
  await movePast(s4.json.id, 30, 480);
  await sweepNoShows();
  const f4after = await prisma.freelancer.findUniqueOrThrow({ where: { id: f4.id } });
  check('MIT Terminal: Worker erkennt No-Show automatisch und sperrt', f4after.accountStatus === 'SUSPENDED' && f4after.reliabilityScore === 0.75, f4after.accountStatus);
  check('Schlüssel widerrufen → 204', (await api('DELETE', `/api/v1/restaurants/${rid}/api-keys/${k.json.id}`, owner!.id)).status === 204);
  check('widerrufener Schlüssel → 401', (await ig('GET', '/api/v1/integrations/shifts', k.json.key)).status === 401);

  console.log('— Sofortmeldung geführt');
  check('E-Mail an den Wirt nach der Zusage: Sofortmeldung abgeben', await mailSent('owner@smoketest.invalid', 'Sofortmeldung abgeben'));
  const smeld = async (id: string) => (await api('GET', '/api/v1/marketplace/my-shifts', owner!.id)).json.find((x: { id: string }) => x.id === id)?.sofortmeldung;
  const sm0 = await smeld(s3.json.id);
  check('Meldedaten bereit, noch nicht gemeldet', sm0?.status === 'READY' && !sm0.reportedAt, sm0);
  const rep = (id: string, user: string, b: unknown = {}) => api('POST', `/api/v1/marketplace/shifts/${id}/sofortmeldung/reported`, user, b);
  check('als gemeldet markieren durch Fremde → 403', (await rep(s3.json.id, stranger!.id)).status === 403);
  check('als gemeldet markieren → 204', (await rep(s3.json.id, owner!.id, { reference: 'ABC-123' })).status === 204);
  check('erneut markieren → 409', (await rep(s3.json.id, owner!.id)).status === 409);
  const sm1 = await smeld(s3.json.id);
  check('Status gemeldet, mit Zeitpunkt und Referenz', sm1?.status === 'SENT' && sm1.reference === 'ABC-123' && !!sm1.reportedAt, sm1);
  const { activityKey: _omit, ...withoutKey } = good;
  const matchNew = async (f: { id: string }, hoursAhead: number, body: Record<string, unknown> = good) => {
    const sh = await api('POST', '/api/v1/marketplace/shifts', owner!.id, { ...body, startTime: new Date(Date.now() + hoursAhead * 3600_000).toISOString(), endTime: new Date(Date.now() + (hoursAhead + 8) * 3600_000).toISOString() });
    await prisma.shiftApplication.create({ data: { shiftId: sh.json.id, freelancerId: f.id } });
    const ac = await api('POST', `/api/v1/marketplace/shifts/${sh.json.id}/accept`, owner!.id, { freelancerId: f.id });
    if (ac.status !== 200) throw new Error('Zusage im Test fehlgeschlagen: ' + JSON.stringify(ac));
    return sh.json.id as string;
  };
  const f5 = await mkF('ohne-schluessel');
  const s5 = await matchNew(f5, 2, withoutKey);
  const sm5 = await smeld(s5);
  check('ohne Tätigkeitsschlüssel: Angaben fehlen', sm5?.status === 'NEEDS_DATA' && sm5.missingFields.includes('taetigkeitsschluessel'), sm5);
  check('ungültiger Schlüssel → 400', (await api('PUT', `/api/v1/marketplace/shifts/${s5}/activity-key`, owner!.id, { activityKey: '123' })).status === 400);
  check('Schlüssel durch Fremde → 403', (await api('PUT', `/api/v1/marketplace/shifts/${s5}/activity-key`, stranger!.id, { activityKey: '123456789' })).status === 403);
  const ak = await api('PUT', `/api/v1/marketplace/shifts/${s5}/activity-key`, owner!.id, { activityKey: '123456789' });
  check('Schlüssel ergänzt → Meldedaten bereit', ak.status === 200 && ak.json.status === 'READY' && (await smeld(s5)).missingFields.length === 0, ak);
  const exp5 = await api('GET', `/api/v1/marketplace/shifts/${s5}/sofortmeldung-export`, owner!.id);
  check('Export enthält jetzt den Schlüssel', exp5.json?.data?.taetigkeitsschluessel === '123456789', exp5.json?.data);
  await remindSofortmeldung();
  check('Erinnerung an den Wirt: Sofortmeldung fehlt noch', await mailSent('owner@smoketest.invalid', 'Erinnerung: Sofortmeldung'));

  console.log('— Absagen nach der Zusage');
  const cancelA = (id: string, user: string, b: unknown = {}) => api('POST', `/api/v1/marketplace/shifts/${id}/cancel-assignment`, user, b);
  const shiftRow = (id: string) => prisma.marketplaceShift.findUniqueOrThrow({ where: { id }, include: { assignment: true } });
  // A) rechtzeitig (30 h vorher), früher abgelehnter Bewerber wird wieder informiert
  const fa = await mkF('sagt-rechtzeitig-ab'), fb = await mkF('war-abgelehnt');
  const shA = (await api('POST', '/api/v1/marketplace/shifts', owner!.id, { ...good, startTime: new Date(Date.now() + 30 * 3600_000).toISOString(), endTime: new Date(Date.now() + 38 * 3600_000).toISOString() })).json.id as string;
  await prisma.shiftApplication.createMany({ data: [{ shiftId: shA, freelancerId: fa.id }, { shiftId: shA, freelancerId: fb.id }] });
  await api('POST', `/api/v1/marketplace/shifts/${shA}/accept`, owner!.id, { freelancerId: fa.id });
  check('Absage durch eine andere Aushilfe → 404', (await cancelA(shA, fb.userId)).status === 404);
  const ca = await cancelA(shA, fa.userId, { reason: 'krank' });
  check('rechtzeitige Absage → 200, keine Strafe', ca.status === 200 && ca.json.late === false && ca.json.reliabilityScore === 1 && ca.json.suspended === false, ca);
  const rowA = await shiftRow(shA);
  check('Schicht wieder OFFEN, Zusage samt Meldedatensatz entfernt', rowA.status === 'OPEN' && rowA.assignment === null);
  check('Bewerbung der Absagenden = CANCELLED, die des anderen wieder frei', (await prisma.shiftApplication.findFirstOrThrow({ where: { shiftId: shA, freelancerId: fa.id } })).status === 'CANCELLED' && (await prisma.shiftApplication.findFirstOrThrow({ where: { shiftId: shA, freelancerId: fb.id } })).status === 'WITHDRAWN');
  check('E-Mail an den Wirt: Absage', await mailSent('owner@smoketest.invalid', 'Absage: sagt-rechtzeitig-ab'));
  check('E-Mail an früheren Bewerber: Schicht wieder frei', await mailSent('war-abgelehnt@smoketest.invalid', 'Schicht wieder frei'));
  check('frei gewordene Schicht erscheint wieder in der Suche des anderen', (await api('GET', '/api/v1/marketplace/search', fb.userId)).json?.shifts?.some((x: { id: string }) => x.id === shA));
  check('die Absagende sieht die Schicht nicht wieder', !(await api('GET', '/api/v1/marketplace/search', fa.userId)).json?.shifts?.some((x: { id: string }) => x.id === shA));
  check('Absage ist protokolliert', (await prisma.shiftCancellation.count({ where: { shiftId: shA, cancelledBy: 'FREELANCER', late: false } })) === 1);
  check('zweite Absage derselben Schicht → 404', (await cancelA(shA, fa.userId)).status === 404);
  // B) kurzfristig (5 h vorher) mit bereits gemeldeter Sofortmeldung, danach zweite kurzfristige Absage → Sperre
  const fc = await mkF('sagt-kurzfristig-ab');
  const shB = await matchNew(fc, 5);
  await rep(shB, owner!.id, { reference: 'X1' });
  const cb = await cancelA(shB, fc.userId);
  check('kurzfristige Absage → Score 0.9, noch keine Sperre', cb.status === 200 && cb.json.late === true && cb.json.reliabilityScore === 0.9 && cb.json.suspended === false, cb);
  check('Wirt wird an das Stornieren der Sofortmeldung erinnert', await mailSent('owner@smoketest.invalid', 'Absage: sagt-kurzfristig-ab', 'stornieren'));
  const shB2 = await matchNew(fc, 6);
  const cb2 = await cancelA(shB2, fc.userId);
  check('zweite kurzfristige Absage → Score 0.8 und Sperre', cb2.status === 200 && cb2.json.suspended === true && cb2.json.reliabilityScore === 0.8, cb2);
  check('Aushilfe ist gesperrt, Zähler steht bei 2', (await prisma.freelancer.findUniqueOrThrow({ where: { id: fc.id } })).lateCancelCount === 2);
  check('E-Mail an die Aushilfe: Konto gesperrt', await mailSent('sagt-kurzfristig-ab@smoketest.invalid', 'gesperrt'));
  // C) nach Beginn keine Absage mehr
  check('Absage nach Schichtbeginn/Einchecken → 409', (await cancelA(s3.json.id, f3.userId)).status === 409);
  // D) Betrieb nimmt die Zusage zurück
  const fe = await mkF('betrieb-nimmt-zurueck');
  const shD = await matchNew(fe, 20);
  const cm = (id: string, user: string, b: unknown) => api('POST', `/api/v1/marketplace/shifts/${id}/cancel-match`, user, b);
  check('Zusage zurücknehmen durch Fremde → 403', (await cm(shD, stranger!.id, { reopen: true })).status === 403);
  const cm1 = await cm(shD, owner!.id, { reopen: true, reason: 'Umbau' });
  check('Betrieb nimmt zurück und schreibt neu aus → 200', cm1.status === 200, cm1);
  check('Schicht wieder OFFEN, Aushilfe ohne Strafe', (await shiftRow(shD)).status === 'OPEN' && (await prisma.freelancer.findUniqueOrThrow({ where: { id: fe.id } })).reliabilityScore === 1);
  check('E-Mail an die Aushilfe: Zusage zurückgenommen', await mailSent('betrieb-nimmt-zurueck@smoketest.invalid', 'Zusage zurückgenommen'));
  const fg = await mkF('zweite-zusage');
  const shD2 = await matchNew(fg, 22);
  const cm2 = await cm(shD2, owner!.id, { reopen: false });
  check('Betrieb sagt Schicht komplett ab → CANCELLED', cm2.status === 200 && (await shiftRow(shD2)).status === 'CANCELLED', cm2);
  check('zweites Zurücknehmen → 404/409', [404, 409].includes((await cm(shD2, owner!.id, { reopen: true })).status));
  check('Absagen des Betriebs sind protokolliert', (await prisma.shiftCancellation.count({ where: { cancelledBy: 'RESTAURANT' } })) === 2);

  console.log('— Verwaltung');
  const admin = await prisma.user.create({ data: { email: 'admin@smoketest.invalid', emailVerifiedAt: new Date(), isAdmin: true } });
  const A = (m: string, p: string, b?: unknown, user = admin.id) => api(m, '/api/v1/admin' + p, user, b);
  check('Verwaltung als normaler Nutzer → 403', (await A('GET', '/stats', undefined, owner!.id)).status === 403);
  check('Verwaltung ohne Login → 401', (await api('GET', '/api/v1/admin/stats', null)).status === 401);
  const st = await A('GET', '/stats');
  check('Statistik', st.status === 200 && st.json.freelancers >= 3 && st.json.shifts.open >= 0, st);
  const fl = await A('GET', '/freelancers?q=Selbst');
  const fx = fl.json?.[0];
  check('Aushilfen suchen (Name, E-Mail, Hygiene-Datum)', fl.status === 200 && fx?.email === 'aushilfe@smoketest.invalid' && !!fx.hygieneIssuedOn, fl);
  check('Sperren für 3 Tage → 204', (await A('POST', `/freelancers/${fx.id}/suspend`, { days: 3 })).status === 204);
  check('gesperrte Aushilfe kommt nicht mehr in die Suche → 403', (await fauth('GET', '/api/v1/marketplace/search')).status === 403);
  check('Entsperren → 204, Suche wieder möglich', (await A('POST', `/freelancers/${fx.id}/unsuspend`)).status === 204 && (await fauth('GET', '/api/v1/marketplace/search')).status === 200);
  check('Freischaltung entziehen → Suche 403', (await A('POST', `/freelancers/${fx.id}/unverify`)).status === 204 && (await fauth('GET', '/api/v1/marketplace/search')).status === 403);
  check('Freischaltung erteilen → Suche 200', (await A('POST', `/freelancers/${fx.id}/verify`)).status === 204 && (await fauth('GET', '/api/v1/marketplace/search')).status === 200);
  const av = await fetch(`${BASE}/api/v1/admin/freelancers/${fx.id}/hygiene-certificate`, { headers: { authorization: `Bearer ${token(admin.id)}` } });
  check('Hygienenachweis einsehen (Admin) → 200', av.status === 200 && av.headers.get('content-type') === 'image/png');
  check('Zugriff wurde protokolliert', (await A('GET', '/audit')).json?.some((x: { action: string }) => x.action === 'hygiene-certificate.view'));
  check('Betrieb sperren → 204, offene Schichten storniert', (await A('POST', `/restaurants/${rid}/block`)).status === 204);
  check('gesperrter Betrieb kann nicht ausschreiben → 403', (await api('POST', '/api/v1/marketplace/shifts', owner!.id, good)).status === 403);
  check('Betrieb entsperren → Ausschreiben wieder möglich', (await A('POST', `/restaurants/${rid}/unblock`)).status === 204 && (await api('POST', '/api/v1/marketplace/shifts', owner!.id, good)).status === 201);
  check('Betriebe suchen', (await A('GET', '/restaurants?q=Smoketest')).json?.some((r: { id: string }) => r.id === rid));

  console.log('— Konto löschen (DSGVO)');
  check('Konto löschen mit falschem Passwort → 401', (await fauth('DELETE', '/api/v1/freelancers/me', { password: 'falsch-falsch-falsch' })).status === 401);
  const fuser = await prisma.user.findUniqueOrThrow({ where: { email: freg.email } });
  const del = await fauth('DELETE', '/api/v1/freelancers/me', { password: freg.password });
  check('Konto löschen → 204', del.status === 204, del);
  const gone = await prisma.freelancer.findFirstOrThrow({ where: { userId: fuser.id }, include: { user: true, hygieneCertificate: true } });
  check('Konto anonymisiert (Name, E-Mail, Telefon, Nachweis entfernt)', gone.displayName === 'Gelöschter Nutzer' && gone.user.email.endsWith('@deleted.invalid') && gone.user.phone === null && gone.hygieneCertificate === null && gone.user.deletedAt !== null && !gone.verified);
  check('Anmeldung nach Löschung nicht mehr möglich → 401', (await api('POST', '/api/v1/auth/login', null, { email: freg.email, password: freg.password })).status === 401);
  check('Meldedatensatz bleibt (Aufbewahrungspflicht)', (await prisma.temporaryEmployee.count({ where: { freelancerId: gone.id } })) >= 1);
}

main()
  .catch(e => { console.error(e); failed++; })
  .finally(async () => { await cleanup(); await prisma.$disconnect(); console.log(failed ? `\n${failed} FEHLER` : '\nALLE TESTS BESTANDEN'); process.exit(failed ? 1 : 0); });
