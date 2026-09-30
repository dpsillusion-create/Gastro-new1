import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db';
import { badRequest, conflict, forbidden, unauthorized } from '../errors';
import { authenticate } from '../middleware/auth';
import { geocodeAddress } from '../services/geocode';
import { checkCode, issueCode, pendingToken, readPendingToken, sessionToken, startSignupVerification } from '../services/otp';
import { hashPassword, verifyPassword } from '../services/password';
import { normalizePhone } from '../services/phone';

export const authRouter = Router();
// Brute-Force-Schutz (pro IP; setzt `trust proxy` hinter nginx voraus, siehe app.ts)
const strict = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

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
  // Optional (z. B. Tests/Sonderfälle); ohne Angabe wird die Adresse geocodiert
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
}).strict();

const TAKEN = 'E-Mail-Adresse oder Handynummer ist bereits registriert';

/**
 * Registrierung eines Gastronomen. Legt Nutzer, Restaurant und Inhaber-Zuordnung an und sendet je einen Code
 * per E-Mail und SMS. Ein Sitzungstoken gibt es erst nach Bestätigung beider Codes (POST /auth/verify).
 */
authRouter.post('/register', strict, async (req, res, next) => {
  try {
    const b = registerSchema.parse(req.body);
    if (await prisma.user.findFirst({ where: { OR: [{ email: b.email }, { phone: b.phone }] }, select: { id: true } })) throw conflict(TAKEN);
    const geo = b.latitude != null && b.longitude != null
      ? { latitude: b.latitude, longitude: b.longitude } : await geocodeAddress(b.street, b.zip, b.city);
    const user = await prisma.user.create({
      data: {
        email: b.email, phone: b.phone, passwordHash: await hashPassword(b.password),
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

/** Kontobestätigung: E-Mail-Code und SMS-Code. Jeder richtige Code wird einzeln gutgeschrieben; mit beiden gibt es die Sitzung. */
authRouter.post('/verify', strict, async (req, res, next) => {
  try {
    const b = z.object({ verificationToken: z.string(), emailCode: z.string().max(10).optional(), phoneCode: z.string().max(10).optional() }).strict().parse(req.body);
    const userId = readPendingToken(b.verificationToken, 'signup');
    let user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const wrong: string[] = [];
    if (!user.emailVerifiedAt && b.emailCode) {
      if (await checkCode(userId, 'SIGNUP', 'EMAIL', b.emailCode)) user = await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
      else wrong.push('E-Mail-Code');
    }
    if (!user.phoneVerifiedAt && b.phoneCode) {
      if (await checkCode(userId, 'SIGNUP', 'SMS', b.phoneCode)) user = await prisma.user.update({ where: { id: userId }, data: { phoneVerifiedAt: new Date() } });
      else wrong.push('SMS-Code');
    }
    if (user.emailVerifiedAt && user.phoneVerifiedAt) return void res.json({ token: sessionToken(user.id) });
    res.status(400).json({
      error: 'CODE_INVALID', emailVerified: !!user.emailVerifiedAt, phoneVerified: !!user.phoneVerifiedAt,
      message: wrong.length ? `${wrong.join(' und ')} falsch oder abgelaufen` : 'Bitte beide Codes eingeben',
    });
  } catch (err) { next(err); }
});

/** Code erneut senden. Für Registrierung (`verificationToken`, Kanal frei wählbar) und Anmeldung (`challengeToken`). */
authRouter.post('/resend', strict, async (req, res, next) => {
  try {
    const b = z.object({ token: z.string(), purpose: z.enum(['signup', 'login']), channel: z.enum(['EMAIL', 'SMS']) }).strict().parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: readPendingToken(b.token, b.purpose) } });
    await issueCode(user, b.purpose === 'signup' ? 'SIGNUP' : 'LOGIN', b.channel);
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * Schritt 1 der Anmeldung: Passwort prüfen. Danach geht ein 6-stelliger Code per SMS raus (zweiter Faktor);
 * das Sitzungstoken gibt es erst nach POST /auth/login/verify. Nicht bestätigte Konten müssen zuerst verifiziert werden.
 */
authRouter.post('/login', strict, async (req, res, next) => {
  try {
    const { email, password } = z.object({ email: z.string().trim().toLowerCase(), password: z.string().max(128) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) throw unauthorized('E-Mail oder Passwort falsch'); // bewusst identische Meldung
    if (!user.phone) throw forbidden('Für dieses Konto ist keine Handynummer hinterlegt – bitte neu registrieren');
    if (!user.emailVerifiedAt || !user.phoneVerifiedAt) {
      await issueCode(user, 'SIGNUP', 'EMAIL'); await issueCode(user, 'SIGNUP', 'SMS');
      return void res.status(403).json({ error: 'NOT_VERIFIED', message: 'Bitte zuerst E-Mail und Handynummer bestätigen', verificationToken: pendingToken(user.id, 'signup') });
    }
    await issueCode(user, 'LOGIN', 'SMS');
    res.json({ twoFactor: true, challengeToken: pendingToken(user.id, 'login'), phoneHint: user.phone.slice(0, 3) + '…' + user.phone.slice(-2) });
  } catch (err) { next(err); }
});

/** Schritt 2 der Anmeldung: Code (SMS oder E-Mail, je nach zuletzt angefordertem Kanal) → Sitzungstoken. */
authRouter.post('/login/verify', strict, async (req, res, next) => {
  try {
    const b = z.object({ challengeToken: z.string(), code: z.string().min(4).max(10) }).strict().parse(req.body);
    const userId = readPendingToken(b.challengeToken, 'login');
    const ok = (await checkCode(userId, 'LOGIN', 'SMS', b.code)) || (await checkCode(userId, 'LOGIN', 'EMAIL', b.code));
    if (!ok) throw badRequest('Code falsch oder abgelaufen');
    res.json({ token: sessionToken(userId) });
  } catch (err) { next(err); }
});

/** Eigenes Profil inkl. Restaurants (für die Weboberfläche). */
authRouter.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { email: true, memberships: { select: { role: true, restaurant: { select: { id: true, name: true, city: true } } } } },
    });
    res.json({ email: user.email, restaurants: user.memberships.map(m => ({ ...m.restaurant, role: m.role })) });
  } catch (err) { next(err); }
});
