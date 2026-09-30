import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { prisma } from '../db';
import { forbidden, unauthorized } from '../errors';
import { liftExpiredSuspension } from '../services/reliability';

declare module 'express-serve-static-core' {
  interface Request { userId?: string }
}

// Kurzzeit-Cache (10 s), damit nicht jede Anfrage die Datenbank fragt; Änderungen im selben Prozess heben ihn sofort auf.
const sessionCache = new Map<string, { until: number; ok: boolean; validFrom: number | null }>();
export function invalidateSessions(userId: string) { sessionCache.delete(userId); }

/**
 * Validiert das Bearer-JWT (Nutzer-ID im Feld `sub`) und prüft dann gegen die Datenbank, dass das Konto existiert, nicht
 * gelöscht ist und die Sitzung nicht durch Passwort-Reset/Löschung für ungültig erklärt wurde (`sessionsValidFrom`).
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || !payload.sub || payload.typ) return next(unauthorized()); // `typ` = Zwischen-Token (2FA)
    let c = sessionCache.get(payload.sub);
    if (!c || c.until < Date.now()) {
      const u = await prisma.user.findUnique({ where: { id: payload.sub }, select: { deletedAt: true, sessionsValidFrom: true } });
      c = { until: Date.now() + 10_000, ok: !!u && !u.deletedAt, validFrom: u?.sessionsValidFrom?.getTime() ?? null };
      sessionCache.set(payload.sub, c);
    }
    // Ausgestellt in einer früheren Sekunde als die Invalidierung → ungültig (Sekunden-Granularität von `iat`)
    if (!c.ok || (c.validFrom !== null && (payload.iat ?? 0) < Math.floor(c.validFrom / 1000))) return next(unauthorized('Sitzung abgelaufen – bitte erneut anmelden'));
    req.userId = payload.sub;
    next();
  } catch (e) {
    next(e instanceof jwt.JsonWebTokenError || e instanceof jwt.TokenExpiredError ? unauthorized('Token ungültig oder abgelaufen') : e);
  }
}

/**
 * Autorisierung: Der User muss OWNER/MANAGER des Restaurants sein.
 * Immer gegen die DB prüfen – niemals Restaurant-IDs aus dem Token vertrauen.
 */
export async function assertRestaurantManager(userId: string, restaurantId: string) {
  const m = await prisma.restaurantMember.findUnique({
    where: { userId_restaurantId: { userId, restaurantId } },
    select: { role: true },
  });
  if (!m || m.role === 'STAFF') throw forbidden('Kein Zugriff auf dieses Restaurant');
}

/**
 * Nur der Inhaber (Rolle OWNER = "RESTAURANT_OWNER") des konkreten Restaurants darf fortfahren.
 * Prüft die Zuordnung in der DB → verhindert ID-Spoofing (fremde restaurantId im Body).
 * Nicht existierende und fremde Restaurants liefern identisch 403, damit keine Existenz verraten wird.
 */
export async function assertRestaurantOwner(userId: string, restaurantId: string) {
  const m = await prisma.restaurantMember.findUnique({
    where: { userId_restaurantId: { userId, restaurantId } },
    select: { role: true },
  });
  if (!m || m.role !== 'OWNER') throw forbidden('Nur der Inhaber des Restaurants darf Schichten ausschreiben');
}

/** Lädt das Freelancer-Profil: verifiziert und nicht gesperrt (abgelaufene Sperren werden dabei aufgehoben). */
export async function requireFreelancer(userId: string) {
  let f = await prisma.freelancer.findUnique({ where: { userId } });
  if (!f) throw forbidden('Kein Freelancer-Profil');
  if (f.accountStatus === 'SUSPENDED') {
    await liftExpiredSuspension(f.id);
    f = await prisma.freelancer.findUniqueOrThrow({ where: { id: f.id } });
    if (f.accountStatus === 'SUSPENDED')
      throw forbidden(`Account bis ${f.suspendedUntil?.toISOString()} gesperrt (Zuverlässigkeit)`);
  }
  if (!f.verified) throw forbidden('Profil noch nicht verifiziert');
  return f;
}

/** Bewerbung nur mit validierten Pflichtangaben (SV-Nummer, Steuer-ID, Geburtsdatum). */
export function assertComplianceValidated(f: { complianceValidatedAt: Date | null }) {
  if (!f.complianceValidatedAt) throw forbidden('Pflichtangaben (SV-Nummer, Steuer-ID, Geburtsdatum) nicht validiert');
}
