import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { TERMS_VERSION } from '../config';
import { prisma } from '../db';
import { badRequest, conflict, forbidden, unauthorized, wrongPassword } from '../errors';
import { authenticate } from '../middleware/auth';
import { submitComplianceData, validateBirthDate, validateSocialSecurityNumber, validateTaxId } from '../services/compliance';
import { decrypt, encrypt } from '../services/crypto';
import { geocodeAddress } from '../services/geocode';
import { phoneField } from './auth';
import { startSignupVerification } from '../services/otp';
import { anonymizeUser } from '../services/accountDeletion';
import { hashPassword, verifyPassword } from '../services/password';
import { saveHygieneCertificate } from '../services/hygiene';
import { liftExpiredSuspension } from '../services/reliability';

export const freelancerRouter = Router();
const TAKEN = 'Diese E-Mail-Adresse ist bereits registriert';
const Skill = z.enum(['BAR', 'SERVICE', 'KITCHEN', 'DISHWASHING']);

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Ungültige E-Mail-Adresse').max(200),
  phone: phoneField,
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
freelancerRouter.post('/register', rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 20) }), async (req, res, next) => {
  try {
    const b = registerSchema.parse(req.body);
    if (!validateBirthDate(b.birthDate)) throw badRequest('Geburtsdatum ungültig (Mindestalter 16)');
    if (!validateSocialSecurityNumber(b.socialSecurityNumber, b.birthDate))
      throw badRequest('Sozialversicherungsnummer ungültig oder passt nicht zum Geburtsdatum');
    if (!validateTaxId(b.taxId)) throw badRequest('Steuer-ID ungültig');
    if (await prisma.user.findUnique({ where: { email: b.email }, select: { id: true } }))
      throw conflict(TAKEN);
    const geo = await geocodeAddress(undefined, b.zip, b.city);
    const user = await prisma.user.create({
      data: {
        email: b.email, phone: b.phone, passwordHash: await hashPassword(b.password), termsAcceptedAt: new Date(), termsVersion: TERMS_VERSION,
        freelancer: { create: {
          displayName: b.displayName, claimedSkills: b.skills, homeLatitude: geo.latitude, homeLongitude: geo.longitude,
          socialSecurityNumberEnc: encrypt(b.socialSecurityNumber.replace(/\s/g, '').toUpperCase()),
          taxIdEnc: encrypt(b.taxId.replace(/\s/g, '')), birthDate: b.birthDate,
          complianceValidatedAt: new Date(), privacyConsentAt: new Date(),
        } },
      },
    });
    // E-Mail-Code; Sitzung erst nach Bestätigung (POST /auth/verify)
    res.status(201).json({ verificationToken: await startSignupVerification(user) });
  } catch (err) {
    if ((err as { code?: string })?.code === 'P2002') return next(conflict(TAKEN));
    next(err);
  }
});

freelancerRouter.use(authenticate);

/** Eigenes Profil und Status (auch für noch nicht verifizierte/gesperrte Nutzer abrufbar). */
freelancerRouter.get('/me', async (req, res, next) => {
  try {
    const me = await prisma.freelancer.findUnique({ where: { userId: req.userId! }, select: { id: true, user: { select: { totpEnabledAt: true } } } });
    if (!me) throw forbidden('Kein Freelancer-Profil');
    await liftExpiredSuspension(me.id);
    const f = await prisma.freelancer.findUniqueOrThrow({ where: { id: me.id } });
    const cert = await prisma.hygieneCertificate.findUnique({ where: { freelancerId: me.id }, select: { issuedOn: true } });
    res.json({
      displayName: f.displayName, verified: f.verified, verifiedSkills: f.verifiedSkills, claimedSkills: f.claimedSkills,
      rating: f.ratingCount ? +(f.ratingSum / f.ratingCount).toFixed(2) : null, ratingCount: f.ratingCount,
      reliabilityScore: f.reliabilityScore, accountStatus: f.accountStatus, suspendedUntil: f.suspendedUntil,
      complianceValidated: !!f.complianceValidatedAt, totpEnabled: !!me.user.totpEnabledAt, hygiene: cert ? { issuedOn: cert.issuedOn } : null,
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

/**
 * Hygienenachweis (Belehrung nach § 43 IfSG) hochladen: Foto/PDF als Base64 + Ausstellungsdatum.
 * Beim ersten Upload wird das Profil automatisch freigeschaltet.
 */
freelancerRouter.put('/me/hygiene-certificate', rateLimit({ windowMs: 60 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 15) }), async (req, res, next) => {
  try {
    const b = z.object({ file: z.string().min(100), issuedOn: z.coerce.date() }).strict().parse(req.body);
    const f = await prisma.freelancer.findUnique({ where: { userId: req.userId! }, select: { id: true } });
    if (!f) throw forbidden('Kein Freelancer-Profil');
    await saveHygieneCertificate(f.id, b.file, b.issuedOn);
    res.status(204).end();
  } catch (err) { next(err); }
});

/** Konto löschen (DSGVO). Nicht möglich, solange eine bestätigte Schicht noch bevorsteht. Meldedaten bleiben aufbewahrungspflichtig erhalten. */
freelancerRouter.delete('/me', async (req, res, next) => {
  try {
    const { password } = z.object({ password: z.string().max(128) }).strict().parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, include: { freelancer: { select: { id: true } } } });
    if (!(await verifyPassword(password, user.passwordHash))) throw wrongPassword();
    if (user.freelancer && await prisma.temporaryEmployee.count({ where: { freelancerId: user.freelancer.id, validUntil: { gt: new Date() }, shift: { status: 'MATCHED' } } }))
      throw conflict('Du hast noch eine bestätigte Schicht. Bitte erst absolvieren oder mit dem Betrieb klären.');
    await anonymizeUser(user.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

/**
 * Datenauskunft (DSGVO Art. 15/20): alle zur eigenen Person gespeicherten Daten als JSON-Datei. Erfordert das Passwort
 * (die Datei enthält auch SV-Nummer und Steuer-ID im Klartext) und ist streng begrenzt.
 */
freelancerRouter.post('/me/export', rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 5) }), async (req, res, next) => {
  try {
    const { password } = z.object({ password: z.string().max(128) }).strict().parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId! }, include: { pushSubscriptions: { select: { createdAt: true, userAgent: true } },
      freelancer: { include: { hygieneCertificate: { select: { issuedOn: true, uploadedAt: true, mimeType: true } },
        applications: { orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true, decidedAt: true, shift: { select: { role: true, startTime: true, endTime: true, hourlyRateCents: true, restaurant: { select: { name: true, city: true } } } } } },
        tempEmployees: { select: { validFrom: true, validUntil: true, clockedInAt: true, noShowRecordedAt: true, restaurant: { select: { name: true } } } } } } } });
    if (!(await verifyPassword(password, user.passwordHash))) throw wrongPassword();
    const f = user.freelancer; if (!f) throw forbidden('Kein Freelancer-Profil');
    const cancellations = await prisma.shiftCancellation.findMany({ where: { freelancerId: f.id }, select: { cancelledBy: true, hoursBeforeStart: true, late: true, reason: true, createdAt: true } });
    const out = {
      erstelltAm: new Date().toISOString(),
      hinweis: 'Dies sind alle bei GastroEvolution SmartShift Swap zu deiner Person gespeicherten Daten. Gesetzlich aufbewahrungspflichtige Meldedaten früherer Einsätze können nach einer Kontolöschung beim Arbeitgeber bzw. bei uns verbleiben.',
      konto: { email: user.email, telefon: user.phone, registriertAm: f.createdAt, emailBestaetigtAm: user.emailVerifiedAt, zweiFaktorPerApp: !!user.totpEnabledAt,
        nutzungsbedingungen: { zugestimmtAm: user.termsAcceptedAt, version: user.termsVersion }, datenschutzEinwilligungAm: f.privacyConsentAt, pushGeraete: user.pushSubscriptions },
      profil: { name: f.displayName, geburtsdatum: f.birthDate, sozialversicherungsnummer: decrypt(f.socialSecurityNumberEnc), steuerId: decrypt(f.taxIdEnc),
        faehigkeitenAngegeben: f.claimedSkills, faehigkeitenFreigeschaltet: f.verifiedSkills, freigeschaltet: f.verified, wohnortKoordinaten: f.homeLatitude != null ? { lat: f.homeLatitude, lon: f.homeLongitude } : null,
        bewertungSumme: f.ratingSum, bewertungAnzahl: f.ratingCount, zuverlaessigkeit: f.reliabilityScore, nichtErschienen: f.noShowCount, kurzfristigeAbsagen: f.lateCancelCount, status: f.accountStatus, gesperrtBis: f.suspendedUntil },
      hygienenachweis: f.hygieneCertificate ? { ausgestelltAm: f.hygieneCertificate.issuedOn, hochgeladenAm: f.hygieneCertificate.uploadedAt, dateityp: f.hygieneCertificate.mimeType } : null,
      bewerbungen: f.applications, einsaetze: f.tempEmployees, absagen: cancellations,
    };
    res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="meine-daten.json"' }).send(JSON.stringify(out, null, 2));
  } catch (err) { next(err); }
});
