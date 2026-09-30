import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { TERMS_VERSION } from '../config';
import { prisma } from '../db';
import QRCode from 'qrcode';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../errors';
import { authenticate } from '../middleware/auth';
import { geocodeAddress } from '../services/geocode';
import { decrypt, encrypt } from '../services/crypto';
import { checkCode, issueCode, pendingToken, readPendingToken, sessionToken, startSignupVerification } from '../services/otp';
import { hashPassword, verifyPassword } from '../services/password';
import { normalizePhone } from '../services/phone';
import { findValidInvitation } from '../services/team';
import { generateSecret, otpauthUri, verifyTotp } from '../services/totp';

export const authRouter = Router();
// Brute-Force-Schutz (pro IP; setzt `trust proxy` hinter nginx voraus, siehe app.ts)
const strict = rateLimit({
  windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 30), standardHeaders: true, legacyHeaders: false,
  message: { error: 'RATE_LIMIT', message: 'Zu viele Anfragen – bitte in einigen Minuten erneut versuchen' },
});

/** Zod-Baustein: Handynummer → E.164. */
export const phoneField = z.string().trim().transform((v, ctx) => {
  const n = normalizePhone(v);
  if (!n) ctx.addIssue({ code: 'custom', message: 'Handynummer ungültig (z. B. 0171 1234567)' });
  return n ?? '';
});

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Ungültige E-Mail-Adresse').max(200),
  phone: phoneField,
  password: z.string().min(10, 'Passwort: mindestens 10 Zeichen').max(128),
  restaurantName: z.string().trim().min(2, 'Name des Betriebs fehlt').max(120),
  street: z.string().trim().min(3, 'Straße und Hausnummer fehlen').max(120),
  zip: z.string().regex(/^\d{5}$/, 'PLZ: 5 Ziffern'),
  city: z.string().trim().min(2, 'Ort fehlt').max(80),
  betriebsnummer: z.string().regex(/^\d{8}$/, 'Betriebsnummer: 8 Ziffern (für die Sofortmeldung)'),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Bitte Nutzungsbedingungen und Datenschutz akzeptieren' }) }),
  // Optional (z. B. Tests/Sonderfälle); ohne Angabe wird die Adresse geocodiert
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict();

const TAKEN = 'Diese E-Mail-Adresse ist bereits registriert';

/**
 * Registrierung eines Gastronomen. Legt Nutzer, Restaurant und Inhaber-Zuordnung an und sendet einen Code per E-Mail.
 * Die Handynummer ist ein Kontaktdatum (nicht per SMS geprüft). Ein Sitzungstoken gibt es erst nach Bestätigung des E-Mail-Codes.
 */
authRouter.post('/register', strict, async (req, res, next) => {
  try {
    const b = registerSchema.parse(req.body);
    if (await prisma.user.findUnique({ where: { email: b.email }, select: { id: true } })) throw conflict(TAKEN);
    const geo = b.latitude != null && b.longitude != null
      ? { latitude: b.latitude, longitude: b.longitude } : await geocodeAddress(b.street, b.zip, b.city);
    const user = await prisma.user.create({
      data: {
        email: b.email, phone: b.phone, passwordHash: await hashPassword(b.password), termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION,
        memberships: { create: { role: 'OWNER', restaurant: { create: {
          name: b.restaurantName, street: b.street, zip: b.zip, city: b.city, employerBetriebsnummer: b.betriebsnummer, ...geo,
        } } } },
      },
    });
    res.status(201).json({ verificationToken: await startSignupVerification(user) });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return next(conflict(TAKEN));
    next(err);
  }
});

/** Kontobestätigung mit dem E-Mail-Code → Sitzungstoken. */
authRouter.post('/verify', strict, async (req, res, next) => {
  try {
    const b = z.object({ verificationToken: z.string(), emailCode: z.string().max(10) }).strict().parse(req.body);
    const userId = readPendingToken(b.verificationToken, 'signup');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.emailVerifiedAt) {
      if (!(await checkCode(userId, 'SIGNUP', 'EMAIL', b.emailCode))) throw badRequest('Code falsch oder abgelaufen');
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    }
    res.json({ token: sessionToken(userId) });
  } catch (err) { next(err); }
});

/** E-Mail-Code erneut senden – für Registrierung und Anmeldung (auch als Ersatz, wenn die Authenticator-App fehlt). */
authRouter.post('/resend', strict, async (req, res, next) => {
  try {
    const b = z.object({ token: z.string(), purpose: z.enum(['signup', 'login']) }).strict().parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: readPendingToken(b.token, b.purpose) } });
    await issueCode(user, b.purpose === 'signup' ? 'SIGNUP' : 'LOGIN', 'EMAIL');
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * Schritt 1 der Anmeldung: Passwort prüfen. Zweiter Faktor:
 *  - mit eingerichteter Authenticator-App → Code aus der App (`twoFactor: 'totp'`)
 *  - sonst → 6-stelliger Code per E-Mail (`twoFactor: 'email'`)
 * Das Sitzungstoken gibt es erst nach POST /auth/login/verify. Nicht bestätigte Konten müssen zuerst ihre E-Mail bestätigen.
 */
authRouter.post('/login', strict, async (req, res, next) => {
  try {
    const { email, password } = z.object({ email: z.string().trim().toLowerCase(), password: z.string().max(128) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) throw unauthorized('E-Mail oder Passwort falsch'); // bewusst identische Meldung
    if (!user.emailVerifiedAt) {
      await issueCode(user, 'SIGNUP', 'EMAIL');
      return void res.status(403).json({ error: 'NOT_VERIFIED', message: 'Bitte zuerst die E-Mail-Adresse bestätigen', verificationToken: pendingToken(user.id, 'signup') });
    }
    if (user.totpEnabledAt) return void res.json({ twoFactor: 'totp', challengeToken: pendingToken(user.id, 'login') });
    await issueCode(user, 'LOGIN', 'EMAIL');
    res.json({ twoFactor: 'email', challengeToken: pendingToken(user.id, 'login') });
  } catch (err) { next(err); }
});

/** Prüft einen Authenticator-Code inkl. Sperre nach 5 Fehlversuchen (15 Min.) und Replay-Schutz. */
async function checkTotp(userId: string, code: string): Promise<boolean> {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!u.totpSecretEnc || !u.totpEnabledAt) return false;
  if (u.totpLockedUntil && u.totpLockedUntil > new Date()) throw new HttpError(429, 'LOCKED', 'Zu viele Fehlversuche – bitte in 15 Minuten erneut versuchen');
  const step = verifyTotp(decrypt(u.totpSecretEnc), code, u.totpLastStep);
  if (step === null) {
    const failures = u.totpFailures + 1;
    await prisma.user.update({ where: { id: userId }, data: failures >= 5
      ? { totpFailures: 0, totpLockedUntil: new Date(Date.now() + 15 * 60_000) } : { totpFailures: failures } });
    return false;
  }
  // atomar: nur wenn der Schritt noch nicht verbraucht wurde
  const claim = await prisma.user.updateMany({ where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] }, data: { totpLastStep: step, totpFailures: 0 } });
  return claim.count === 1;
}

/** Schritt 2 der Anmeldung: Code aus der Authenticator-App oder – als Ersatz – der E-Mail-Code → Sitzungstoken. */
authRouter.post('/login/verify', strict, async (req, res, next) => {
  try {
    const b = z.object({ challengeToken: z.string(), code: z.string().min(4).max(10) }).strict().parse(req.body);
    const userId = readPendingToken(b.challengeToken, 'login');
    const ok = (await checkTotp(userId, b.code)) || (await checkCode(userId, 'LOGIN', 'EMAIL', b.code));
    if (!ok) throw badRequest('Code falsch oder abgelaufen');
    res.json({ token: sessionToken(userId) });
  } catch (err) { next(err); }
});

// ---- Einladung in einen Betrieb ----
/** Zeigt zu einem Einladungslink Betrieb und eingeladene Adresse (für das Vorbelegen der Registrierung). */
authRouter.get('/invitation/:token', strict, async (req, res, next) => {
  try { const inv = await findValidInvitation(z.string().min(20).max(80).parse(req.params.token)); res.json({ restaurantName: inv.restaurant.name, email: inv.email }); } catch (e) { next(e); }
});
/** Registrierung als eingeladener Manager: kein eigener Betrieb, E-Mail kommt aus der Einladung (wird per Code bestätigt). */
authRouter.post('/register-invited', strict, async (req, res, next) => {
  try {
    const b = z.object({
      token: z.string().min(20).max(80), phone: phoneField, password: z.string().min(10, 'Passwort: mindestens 10 Zeichen').max(128),
      acceptTerms: z.literal(true, { errorMap: () => ({ message: 'Bitte Nutzungsbedingungen und Datenschutz akzeptieren' }) }),
    }).strict().parse(req.body);
    const inv = await findValidInvitation(b.token);
    if (await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } })) throw conflict('Für diese E-Mail-Adresse gibt es schon ein Konto – bitte melde dich an, um die Einladung anzunehmen');
    const user = await prisma.$transaction(async (tx) => {
      const claim = await tx.teamInvitation.updateMany({ where: { id: inv.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: new Date() } });
      if (claim.count !== 1) throw notFound('Einladung ungültig oder abgelaufen');
      return tx.user.create({ data: { email: inv.email, phone: b.phone, passwordHash: await hashPassword(b.password), termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION,
        memberships: { create: { role: inv.role, restaurantId: inv.restaurantId } } } });
    });
    res.status(201).json({ verificationToken: await startSignupVerification(user) });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return next(conflict('Für diese E-Mail-Adresse gibt es schon ein Konto'));
    next(err);
  }
});
/** Bestehendes Konto nimmt eine Einladung an (die E-Mail-Adresse des Kontos muss zur Einladung passen). */
authRouter.post('/invitation/accept', authenticate, strict, async (req, res, next) => {
  try {
    const { token } = z.object({ token: z.string().min(20).max(80) }).strict().parse(req.body);
    const inv = await findValidInvitation(token);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, select: { email: true } });
    if (user.email !== inv.email) throw forbidden('Diese Einladung gilt für eine andere E-Mail-Adresse');
    await prisma.$transaction([
      prisma.restaurantMember.upsert({ where: { userId_restaurantId: { userId: req.userId!, restaurantId: inv.restaurantId } }, create: { userId: req.userId!, restaurantId: inv.restaurantId, role: inv.role }, update: {} }),
      prisma.teamInvitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
    ]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ---- Passwort vergessen: E-Mail-Code → neues Passwort. Die Antwort verrät nie, ob die Adresse existiert. ----
authRouter.post('/password/forgot', strict, async (req, res, next) => {
  try {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).strict().parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user?.passwordHash && !user.deletedAt) await issueCode(user, 'RESET', 'EMAIL').catch((e) => console.error('[reset]', (e as Error).message));
    res.status(204).end();
  } catch (err) { next(err); }
});
authRouter.post('/password/reset', strict, async (req, res, next) => {
  try {
    const b = z.object({ email: z.string().trim().toLowerCase().email(), code: z.string().max(10), newPassword: z.string().min(10, 'Passwort: mindestens 10 Zeichen').max(128) }).strict().parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: b.email } });
    if (!user || user.deletedAt || !(await checkCode(user.id, 'RESET', 'EMAIL', b.code))) throw badRequest('Code falsch oder abgelaufen');
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(b.newPassword), emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ---- Authenticator-App (TOTP) einrichten / entfernen (angemeldet) ----

/** Startet die Einrichtung: neues Secret (noch inaktiv) + QR-Code. Erst /totp/enable schaltet es scharf. */
authRouter.post('/totp/setup', authenticate, strict, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (user.totpEnabledAt) throw conflict('Authenticator ist bereits eingerichtet');
    const secret = generateSecret();
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: encrypt(secret), totpLastStep: null, totpFailures: 0 } });
    const uri = otpauthUri(user.email, secret);
    res.set('Cache-Control', 'no-store').json({ secret, otpauthUri: uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) });
  } catch (err) { next(err); }
});

authRouter.post('/totp/enable', authenticate, strict, async (req, res, next) => {
  try {
    const { code } = z.object({ code: z.string().max(10) }).strict().parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (!user.totpSecretEnc || user.totpEnabledAt) throw conflict('Keine Einrichtung offen');
    const step = verifyTotp(decrypt(user.totpSecretEnc), code, null);
    if (step === null) throw badRequest('Code falsch – bitte den aktuellen Code aus der App eingeben');
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabledAt: new Date(), totpLastStep: step } });
    res.status(204).end();
  } catch (err) { next(err); }
});

/** Entfernen nur mit Passwort UND aktuellem Code aus der App. */
authRouter.post('/totp/disable', authenticate, strict, async (req, res, next) => {
  try {
    const { password, code } = z.object({ password: z.string().max(128), code: z.string().max(10) }).strict().parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! } });
    if (!(await verifyPassword(password, user.passwordHash))) throw unauthorized('Passwort falsch');
    if (!(await checkTotp(user.id, code))) throw badRequest('Code falsch');
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } });
    res.status(204).end();
  } catch (err) { next(err); }
});

/** Eigenes Profil inkl. Restaurants (für die Weboberfläche). */
authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { email: true, totpEnabledAt: true, isAdmin: true, memberships: { select: { role: true, restaurant: { select: { id: true, name: true, city: true } } } } },
    });
    res.json({ email: user.email, totpEnabled: !!user.totpEnabledAt, isAdmin: user.isAdmin, restaurants: user.memberships.map(m => ({ ...m.restaurant, role: m.role })) });
  } catch (err) { next(err); }
});
