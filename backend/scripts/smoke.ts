/**
 * End-to-End-Durchlauf gegen eine echte Datenbank + laufende API.
 * Nutzung:  BASE_URL=http://127.0.0.1:3100 npx tsx scripts/smoke.ts
 * Benötigt dieselben Umgebungsvariablen wie der Server (DATABASE_URL, JWT_SECRET, SSN_ENCRYPTION_KEY).
 * Legt nur eigene Testdaten an (E-Mail-Endung @smoketest.invalid, erfundene Nummern) und löscht sie am Ende.
 */
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { encrypt } from '../src/services/crypto';

const prisma = new PrismaClient();
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const token = (sub: string) => jwt.sign({ sub }, process.env.JWT_SECRET!, { algorithm: 'HS256', expiresIn: '10m' });
let failed = 0;

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

  console.log('— Registrierung / Zwei-Faktor');
  const CODE = '123456'; // = OTP_TEST_CODE des Testservers
  const reg = { email: 'neu@smoketest.invalid', phone: '0171 1000001', password: 'ein-langes-passwort', restaurantName: 'Smoketest Restaurant', street: 'Teststr. 2',
    zip: '20095', city: 'Hamburg', betriebsnummer: '12345678', latitude: 53.55, longitude: 9.99 };
  check('Registrierung mit kurzem Passwort → 400', (await api('POST', '/api/v1/auth/register', null, { ...reg, password: 'kurz' })).status === 400);
  check('ungültige Handynummer → 400', (await api('POST', '/api/v1/auth/register', null, { ...reg, phone: '12345' })).status === 400);
  const rr = await api('POST', '/api/v1/auth/register', null, reg);
  check('Registrierung → 201, noch KEIN Sitzungstoken', rr.status === 201 && !!rr.json.verificationToken && !rr.json.token, rr);
  check('Zwischen-Token ist keine Sitzung → 401', (await fetch(BASE + '/api/v1/auth/me', { headers: { authorization: `Bearer ${rr.json.verificationToken}` } })).status === 401);
  check('doppelte E-Mail → 409', (await api('POST', '/api/v1/auth/register', null, { ...reg, phone: '0171 1000002' })).status === 409);
  check('doppelte Handynummer → 409', (await api('POST', '/api/v1/auth/register', null, { ...reg, email: 'anders@smoketest.invalid' })).status === 409);
  const nv = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('Login vor Bestätigung → 403 NOT_VERIFIED', nv.status === 403 && nv.json?.error === 'NOT_VERIFIED', nv);
  const badCode = await api('POST', '/api/v1/auth/verify', null, { verificationToken: rr.json.verificationToken, emailCode: '000000', phoneCode: CODE });
  check('falscher E-Mail-Code → 400, SMS-Code zählt', badCode.status === 400 && badCode.json.phoneVerified === true && badCode.json.emailVerified === false, badCode);
  const vr = await api('POST', '/api/v1/auth/verify', null, { verificationToken: rr.json.verificationToken, emailCode: CODE });
  check('E-Mail-Code nachgereicht → Sitzungstoken', vr.status === 200 && !!vr.json.token, vr);
  check('Login falsches Passwort → 401', (await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: 'falsch-falsch-falsch' })).status === 401);
  const l1 = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('Login Schritt 1 → Zwei-Faktor verlangt, kein Token', l1.status === 200 && l1.json.twoFactor === true && !l1.json.token, l1);
  check('Login mit falschem Code → 400', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: l1.json.challengeToken, code: '111111' })).status === 400);
  const li = await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: l1.json.challengeToken, code: CODE });
  check('Login Schritt 2 → 200 + Token', li.status === 200 && !!li.json.token, li);
  check('Code nur einmal verwendbar', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: l1.json.challengeToken, code: CODE })).status === 400);
  const l2 = await api('POST', '/api/v1/auth/login', null, { email: reg.email, password: reg.password });
  check('Code per E-Mail anfordern → 204', (await api('POST', '/api/v1/auth/resend', null, { token: l2.json.challengeToken, purpose: 'login', channel: 'EMAIL' })).status === 204);
  check('Login mit E-Mail-Code → 200', (await api('POST', '/api/v1/auth/login/verify', null, { challengeToken: l2.json.challengeToken, code: CODE })).status === 200);
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
  check('Registrierung → 201 (Codes per E-Mail und SMS)', fr0.status === 201 && !!fr0.json.verificationToken, fr0);
  const fr = await api('POST', '/api/v1/auth/verify', null, { verificationToken: fr0.json.verificationToken, emailCode: CODE, phoneCode: CODE });
  check('beide Codes → Sitzung', fr.status === 200 && !!fr.json.token, fr);
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
  const ns = await att(shiftId, 'NO_SHOW');
  check('No-Show senkt Score auf 0.75 und sperrt', ns.status === 200 && ns.json.reliabilityScore === 0.75 && ns.json.suspended, ns);
  check('No-Show idempotent', (await att(shiftId, 'NO_SHOW')).json?.alreadyRecorded === true);
  check('gesperrter Freelancer → 403', (await api('GET', '/api/v1/marketplace/search', fu!.id)).status === 403);
}

main()
  .catch(e => { console.error(e); failed++; })
  .finally(async () => { await cleanup(); await prisma.$disconnect(); console.log(failed ? `\n${failed} FEHLER` : '\nALLE TESTS BESTANDEN'); process.exit(failed ? 1 : 0); });
