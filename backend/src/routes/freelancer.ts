import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config';
import { prisma } from '../db';
import { badRequest, conflict, forbidden } from '../errors';
import { authenticate } from '../middleware/auth';
import { submitComplianceData, validateBirthDate, validateSocialSecurityNumber, validateTaxId } from '../services/compliance';
import { encrypt } from '../services/crypto';
import { geocodeAddress } from '../services/geocode';
import { hashPassword } from '../services/password';
import { liftExpiredSuspension } from '../services/reliability';

export const freelancerRouter = Router();
const Skill = z.enum(['BAR', 'SERVICE', 'KITCHEN', 'DISHWASHING']);

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Ungültige E-Mail-Adresse').max(200),
  password: z.string().min(10, 'Passwort: mindestens 10 Zeichen').max(128),
  displayName: z.string().trim().min(2, 'Name fehlt').max(60),
  zip: z.string().regex(/^\d{5}$/, 'PLZ: 5 Ziffern'),
  city: z.string().trim().min(2, 'Wohnort fehlt').max(80),
  skills: z.array(Skill).min(1, 'Mindestens eine Fähigkeit auswählen').max(4),
  birthDate: z.coerce.date({ errorMap: () => ({ message: 'Geburtsdatum ungültig' }) }),
  socialSecurityNumber: z.string().min(12).max(14),
  taxId: z.string().min(11).max(13),
  privacyConsent: z.literal(true, { errorMap: () => ({ message: 'Bitte der Datenverarbeitung zustimmen' }) }),
}).strict();

/**
 * Registrierung einer Aushilfe. Pflichtangaben werden sofort formal geprüft (Prüfziffern) und verschlüsselt gespeichert.
 * Das Profil startet UNVERIFIZIERT: erst nach manueller Prüfung (Admin) wird es für Schichten freigeschaltet.
 */
freelancerRouter.post('/register', rateLimit({ windowMs: 15 * 60_000, limit: 20 }), async (req, res, next) => {
  try {
    const b = registerSchema.parse(req.body);
    if (!validateBirthDate(b.birthDate)) throw badRequest('Geburtsdatum ungültig (Mindestalter 16)');
    if (!validateSocialSecurityNumber(b.socialSecurityNumber, b.birthDate))
      throw badRequest('Sozialversicherungsnummer ungültig oder passt nicht zum Geburtsdatum');
    if (!validateTaxId(b.taxId)) throw badRequest('Steuer-ID ungültig');
    if (await prisma.user.findUnique({ where: { email: b.email }, select: { id: true } }))
      throw conflict('Diese E-Mail-Adresse ist bereits registriert');
    const geo = await geocodeAddress(undefined, b.zip, b.city);
    const user = await prisma.user.create({
      data: {
        email: b.email, passwordHash: await hashPassword(b.password),
        freelancer: { create: {
          displayName: b.displayName, claimedSkills: b.skills, homeLatitude: geo.latitude, homeLongitude: geo.longitude,
          socialSecurityNumberEnc: encrypt(b.socialSecurityNumber.replace(/\s/g, '').toUpperCase()),
          taxIdEnc: encrypt(b.taxId.replace(/\s/g, '')), birthDate: b.birthDate,
          complianceValidatedAt: new Date(), privacyConsentAt: new Date(),
        } },
      },
    });
    res.status(201).json({ token: jwt.sign({ sub: user.id }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '8h' }) });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return next(conflict('Diese E-Mail-Adresse ist bereits registriert'));
    next(err);
  }
});

freelancerRouter.use(authenticate);

/** Eigenes Profil und Status (auch für noch nicht verifizierte/gesperrte Nutzer abrufbar). */
freelancerRouter.get('/me', async (req, res, next) => {
  try {
    const me = await prisma.freelancer.findUnique({ where: { userId: req.userId! }, select: { id: true } });
    if (!me) throw forbidden('Kein Freelancer-Profil');
    await liftExpiredSuspension(me.id);
    const f = await prisma.freelancer.findUniqueOrThrow({ where: { id: me.id } });
    res.json({
      displayName: f.displayName, verified: f.verified, verifiedSkills: f.verifiedSkills, claimedSkills: f.claimedSkills,
      rating: f.ratingCount ? +(f.ratingSum / f.ratingCount).toFixed(2) : null, ratingCount: f.ratingCount,
      reliabilityScore: f.reliabilityScore, accountStatus: f.accountStatus, suspendedUntil: f.suspendedUntil,
      complianceValidated: !!f.complianceValidatedAt,
    });
  } catch (err) { next(err); }
});

/** Eigene Bewerbungen. Die volle Adresse des Betriebs wird erst nach Bestätigung herausgegeben. */
freelancerRouter.get('/me/applications', async (req, res, next) => {
  try {
    const f = await prisma.freelancer.findUnique({ where: { userId: req.userId! }, select: { id: true } });
    if (!f) throw forbidden('Kein Freelancer-Profil');
    const apps = await prisma.shiftApplication.findMany({
      where: { freelancerId: f.id, status: { not: 'WITHDRAWN' } }, orderBy: { createdAt: 'desc' }, take: 50,
      select: { status: true, shift: { select: {
        id: true, role: true, requirements: true, hourlyRateCents: true, startTime: true, endTime: true, status: true,
        restaurant: { select: { name: true, city: true, street: true, zip: true } },
      } } },
    });
    res.json(apps.map(({ status, shift }) => {
      const { street, zip, ...rest } = shift.restaurant;
      return { status, shift: { ...shift, restaurant: status === 'ACCEPTED' ? { ...rest, street, zip } : rest } };
    }));
  } catch (err) { next(err); }
});

/** Pflichtangaben erneut einreichen/korrigieren. */
freelancerRouter.put('/me/compliance', (req, res, next) => {
  (async () => {
    const body = z.object({
      socialSecurityNumber: z.string().min(12).max(14), taxId: z.string().min(11).max(13), birthDate: z.coerce.date(),
    }).parse(req.body);
    const f = await prisma.freelancer.findUnique({ where: { userId: req.userId! } });
    if (!f) throw forbidden('Kein Freelancer-Profil');
    await submitComplianceData(f.id, body);
    res.status(204).end();
  })().catch(next);
});
