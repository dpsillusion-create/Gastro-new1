import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db';
import { config } from '../config';
import { conflict, unauthorized } from '../errors';
import { authenticate } from '../middleware/auth';
import { geocodeAddress } from '../services/geocode';
import { hashPassword, verifyPassword } from '../services/password';

export const authRouter = Router();

const sign = (userId: string) => jwt.sign({ sub: userId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '8h' });
// Brute-Force-Schutz (pro IP; setzt `trust proxy` hinter nginx voraus, siehe app.ts)
const strict = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Ungültige E-Mail-Adresse').max(200),
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

/** Registrierung eines Gastronomen: legt Nutzer, Restaurant und Inhaber-Zuordnung in einer Transaktion an. */
authRouter.post('/register', strict, async (req, res, next) => {
  try {
    const b = registerSchema.parse(req.body);
    if (await prisma.user.findUnique({ where: { email: b.email }, select: { id: true } }))
      throw conflict('Diese E-Mail-Adresse ist bereits registriert');
    const geo = b.latitude != null && b.longitude != null
      ? { latitude: b.latitude, longitude: b.longitude }
      : await geocodeAddress(b.street, b.zip, b.city);
    const passwordHash = await hashPassword(b.password);
    const user = await prisma.user.create({
      data: {
        email: b.email, passwordHash,
        memberships: { create: { role: 'OWNER', restaurant: { create: {
          name: b.restaurantName, street: b.street, zip: b.zip, city: b.city,
          employerBetriebsnummer: b.betriebsnummer, ...geo,
        } } } },
      },
    });
    res.status(201).json({ token: sign(user.id) });
  } catch (err) {
    // Gleichzeitige Doppel-Registrierung derselben E-Mail (Unique-Verletzung)
    if ((err as { code?: string })?.code === 'P2002') return next(conflict('Diese E-Mail-Adresse ist bereits registriert'));
    next(err);
  }
});

authRouter.post('/login', strict, async (req, res, next) => {
  try {
    const { email, password } = z.object({ email: z.string().trim().toLowerCase(), password: z.string().max(128) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    const ok = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !ok) throw unauthorized('E-Mail oder Passwort falsch'); // bewusst identische Meldung
    res.json({ token: sign(user.id) });
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
