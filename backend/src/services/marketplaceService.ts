import { randomUUID } from 'crypto';
import { Prisma, Skill } from '@prisma/client';
import { prisma } from '../db';
import { conflict, forbidden, notFound } from '../errors';
import { onShiftMatched } from '../integrations/timeTracking';
import { assertComplianceValidated, assertRestaurantManager, assertRestaurantOwner } from '../middleware/auth';
import { dispatchPendingWebhooks } from './webhooks';
import { notifyAccepted, notifyNewApplication, notifyNotSelected, notifySofortmeldungDue } from './notifications';
import { boundingBox } from './geo';

export interface CreateShiftInput {
  restaurantId: string; role: string; requiredSkill: Skill; requirements?: string;
  hourlyRateCents: number; startTime: Date; endTime: Date; activityKey?: string;
  /** Anzahl gesuchter Personen (1–10); jede Stelle wird einzeln besetzt. */
  positions?: number;
}

/** Wirt schreibt eine Schicht aus. Geo-Koordinaten kommen vom Restaurant (nie vom Client). */
export async function createShift(userId: string, input: CreateShiftInput) {
  await assertRestaurantOwner(userId, input.restaurantId);
  const r = await prisma.restaurant.findUnique({ where: { id: input.restaurantId } });
  if (!r) throw notFound('Restaurant nicht gefunden');
  if (r.blockedAt) throw forbidden('Dieser Betrieb ist gesperrt – bitte wende dich an den Support');
  const { positions = 1, ...data } = input;
  const groupId = positions > 1 ? randomUUID() : null;
  const shifts = await prisma.$transaction(Array.from({ length: positions }, (_, i) => prisma.marketplaceShift.create({
    data: { ...data, status: 'OPEN', latitude: r.latitude, longitude: r.longitude, createdById: userId, groupId, slotIndex: i + 1, slotCount: positions },
  })));
  return { ...shifts[0]!, shiftIds: shifts.map((x) => x.id) };
}

export interface SearchInput { freelancerId: string; skills: Skill[]; lat: number; lon: number; radiusKm: number; limit: number }

/**
 * Umkreissuche: Bounding-Box (Index) + exakte Haversine-Distanz in SQL, gefiltert auf
 * offene, zukünftige Schichten passend zu den *verifizierten* Skills, ohne bereits beworbene.
 * Parametrisiert via Prisma.sql → keine SQL-Injection.
 */
export async function searchShifts(i: SearchInput) {
  if (i.skills.length === 0) return [];
  const b = boundingBox(i.lat, i.lon, i.radiusKm);
  return prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
    SELECT * FROM (
      SELECT s.id, s.role, s."requiredSkill", s.requirements, s."hourlyRateCents",
             s."startTime", s."endTime", r.name AS "restaurantName", r.city, s."slotCount",
             CASE WHEN r."ratingCount" > 0 THEN round(r."ratingSum"::numeric / r."ratingCount", 1)::float END AS "restaurantRating", r."ratingCount" AS "restaurantRatingCount",
             CASE WHEN s."groupId" IS NULL THEN 1 ELSE (SELECT count(*)::int FROM "MarketplaceShift" g WHERE g."groupId" = s."groupId" AND g.status = 'OPEN' AND g."startTime" > now()) END AS "openSlots",
             6371.0088 * 2 * asin(least(1, sqrt(
               power(sin(radians(s.latitude - ${i.lat}) / 2), 2) +
               cos(radians(${i.lat})) * cos(radians(s.latitude)) *
               power(sin(radians(s.longitude - ${i.lon}) / 2), 2)))) AS "distanceKm"
      FROM "MarketplaceShift" s
      JOIN "Restaurant" r ON r.id = s."restaurantId"
      WHERE s.status = 'OPEN'
        AND s."startTime" > now()
        AND s."requiredSkill" = ANY(${i.skills}::"Skill"[])
        AND s.latitude  BETWEEN ${b.minLat} AND ${b.maxLat}
        AND s.longitude BETWEEN ${b.minLon} AND ${b.maxLon}
        -- bei mehreren Stellen nur die erste freie Stelle der Gruppe zeigen
        AND (s."groupId" IS NULL OR NOT EXISTS (SELECT 1 FROM "MarketplaceShift" g WHERE g."groupId" = s."groupId" AND g.status = 'OPEN' AND g."slotIndex" < s."slotIndex"))
        -- nicht zeigen, wenn man sich schon (irgendwo in der Gruppe) beworben hat bzw. dort zugesagt/abgesagt wurde
        AND NOT EXISTS (SELECT 1 FROM "ShiftApplication" a JOIN "MarketplaceShift" g ON g.id = a."shiftId"
                        WHERE a."freelancerId" = ${i.freelancerId} AND a.status <> 'WITHDRAWN'
                          AND (g.id = s.id OR (s."groupId" IS NOT NULL AND g."groupId" = s."groupId")))
    ) t
    WHERE t."distanceKm" <= ${i.radiusKm}
    ORDER BY t."distanceKm", t."startTime"
    LIMIT ${i.limit}`);
}

/** Freelancer "swipt": idempotent (Unique shiftId+freelancerId). */
export async function applyToShift(
  freelancer: { id: string; verifiedSkills: Skill[]; complianceValidatedAt: Date | null }, shiftId: string,
) {
  assertComplianceValidated(freelancer); // Regel: ohne validierte Pflichtfelder keine Bewerbung
  const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId } });
  if (!shift) throw notFound('Schicht nicht gefunden');
  if (shift.status !== 'OPEN' || shift.startTime <= new Date()) throw conflict('Schicht nicht mehr offen');
  if (!freelancer.verifiedSkills.includes(shift.requiredSkill)) throw forbidden('Erforderliche Fähigkeit nicht verifiziert');
  if (shift.groupId) { // mehrere Stellen: nur eine Bewerbung pro Ausschreibung
    const dup = await prisma.shiftApplication.findFirst({ where: { freelancerId: freelancer.id, status: { not: 'WITHDRAWN' }, shift: { groupId: shift.groupId }, shiftId: { not: shiftId } } });
    if (dup) throw conflict('Du hast dich für diese Ausschreibung bereits beworben');
  }
  const existing = await prisma.shiftApplication.findUnique({ where: { shiftId_freelancerId: { shiftId, freelancerId: freelancer.id } } });
  if (!existing) { const a = await prisma.shiftApplication.create({ data: { shiftId, freelancerId: freelancer.id } }); notifyNewApplication(shiftId); return a; }
  if (existing.status === 'WITHDRAWN') { // erneut bewerben nach Zurückziehen
    const a = await prisma.shiftApplication.update({ where: { id: existing.id }, data: { status: 'PENDING', decidedAt: null } });
    notifyNewApplication(shiftId); return a;
  }
  return existing; // idempotent
}

/** Freelancer zieht eine noch unentschiedene Bewerbung zurück. */
export async function withdrawApplication(freelancerId: string, shiftId: string) {
  const r = await prisma.shiftApplication.updateMany({
    where: { shiftId, freelancerId, status: 'PENDING' }, data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });
  if (r.count !== 1) throw conflict('Keine offene Bewerbung zum Zurückziehen');
}

/**
 * Wirt bestätigt einen Bewerber. Alles in EINER Transaktion:
 *  1. atomarer Statuswechsel OPEN→MATCHED (updateMany mit Bedingung → kein Doppel-Match bei Race Conditions)
 *  2. Bewerbung ACCEPTED, übrige REJECTED
 *  3. Integrations-Hook (Dienstplan/Zeiterfassung/Sofortmeldung) – Fehler = Rollback
 */
export async function acceptApplication(userId: string, shiftId: string, freelancerId: string) {
  const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId } });
  if (!shift) throw notFound('Schicht nicht gefunden');
  await assertRestaurantManager(userId, shift.restaurantId);

  const result = await prisma.$transaction(async (tx) => {
    const app = await tx.shiftApplication.findUnique({
      where: { shiftId_freelancerId: { shiftId, freelancerId } },
    });
    if (!app || app.status !== 'PENDING') throw notFound('Keine offene Bewerbung');

    // Freelancer darf sich nicht selbst überschneiden (bereits gematchte Schicht im Zeitraum)
    // Seit der Bewerbung könnte der Freelancer gesperrt worden sein oder Daten verloren haben
    const fl = await tx.freelancer.findUniqueOrThrow({ where: { id: freelancerId } });
    if (fl.accountStatus !== 'ACTIVE') throw conflict('Freelancer ist derzeit gesperrt');
    assertComplianceValidated(fl);

    const overlap = await tx.temporaryEmployee.findFirst({
      where: { freelancerId, validFrom: { lt: shift.endTime }, validUntil: { gt: shift.startTime } },
      select: { id: true },
    });
    if (overlap) throw conflict('Freelancer hat im Zeitraum bereits eine andere Schicht');

    const locked = await tx.marketplaceShift.updateMany({
      where: { id: shiftId, status: 'OPEN', version: shift.version },
      data: { status: 'MATCHED', version: { increment: 1 } },
    });
    if (locked.count !== 1) throw conflict('Schicht wurde bereits vergeben oder geändert');

    const now = new Date();
    await tx.shiftApplication.update({ where: { id: app.id }, data: { status: 'ACCEPTED', decidedAt: now } });
    // Übrige Bewerber: bei noch freien Stellen derselben Ausschreibung rücken sie nach, sonst „besetzt“
    const waiting = await tx.shiftApplication.findMany({ where: { shiftId, id: { not: app.id }, status: 'PENDING' }, select: { id: true, freelancerId: true } });
    const nextOpen = shift.groupId && waiting.length
      ? await tx.marketplaceShift.findFirst({ where: { groupId: shift.groupId, status: 'OPEN', id: { not: shiftId }, startTime: { gt: now } }, orderBy: { slotIndex: 'asc' } }) : null;
    let rejectedIds: string[] = [];
    if (nextOpen) {
      await tx.shiftApplication.deleteMany({ where: { shiftId: nextOpen.id, freelancerId: { in: waiting.map((w) => w.freelancerId) }, status: 'WITHDRAWN' } });
      await tx.shiftApplication.updateMany({ where: { id: { in: waiting.map((w) => w.id) } }, data: { shiftId: nextOpen.id } });
    } else {
      await tx.shiftApplication.updateMany({ where: { id: { in: waiting.map((w) => w.id) } }, data: { status: 'REJECTED', decidedAt: now } });
      rejectedIds = waiting.map((w) => w.freelancerId);
    }

    const temp = await onShiftMatched(tx, { ...shift, status: 'MATCHED' }, freelancerId);
    return { shiftId, status: 'MATCHED' as const, temporaryEmployeeId: temp.id, rejectedIds };
  }, { isolationLevel: 'Serializable' });
  // Nach dem Commit: Webhook sofort zustellen (Fire-and-forget; bei Fehler übernimmt der Retry-Worker)
  void dispatchPendingWebhooks().catch(console.error);
  notifyAccepted(shiftId, freelancerId);
  notifySofortmeldungDue(shiftId);
  notifyNotSelected(shiftId, result.rejectedIds, 'FILLED');
  const { rejectedIds: _r, ...publicResult } = result;
  return publicResult;
}

/**
 * Wirt schließt eine Schicht ab und bewertet die Aushilfe (1–5).
 * Voraussetzungen: Schicht MATCHED, Anwesenheit bestätigt (Einchecken), Schichtende erreicht.
 * Atomar: der Statuswechsel MATCHED→COMPLETED verhindert Doppel-Bewertungen.
 */
export async function completeShift(userId: string, shiftId: string, rating: number) {
  const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId } });
  if (!shift) throw notFound('Schicht nicht gefunden');
  await assertRestaurantManager(userId, shift.restaurantId);
  if (shift.endTime > new Date()) throw conflict('Die Schicht ist noch nicht beendet');
  await prisma.$transaction(async (tx) => {
    const temp = await tx.temporaryEmployee.findUnique({ where: { shiftId } });
    if (!temp || shift.status !== 'MATCHED') throw conflict('Nur bestätigte Schichten können abgeschlossen werden');
    if (!temp.clockedInAt) throw conflict('Bitte zuerst die Anwesenheit bestätigen (oder Nichterscheinen melden)');
    const r = await tx.marketplaceShift.updateMany({ where: { id: shiftId, status: 'MATCHED' }, data: { status: 'COMPLETED', rating } });
    if (r.count !== 1) throw conflict('Schicht wurde bereits abgeschlossen');
    await tx.freelancer.update({ where: { id: temp.freelancerId }, data: { ratingSum: { increment: rating }, ratingCount: { increment: 1 } } });
  });
}

/** Die zugesagte Aushilfe bewertet den Betrieb (1–5) – einmalig, erst nach abgeschlossener Schicht. */
export async function rateRestaurant(userId: string, shiftId: string, rating: number) {
  const f = await prisma.freelancer.findUnique({ where: { userId }, select: { id: true } });
  if (!f) throw forbidden('Kein Freelancer-Profil');
  await prisma.$transaction(async (tx) => {
    const shift = await tx.marketplaceShift.findUnique({ where: { id: shiftId }, select: { restaurantId: true, status: true, assignment: { select: { freelancerId: true } } } });
    if (!shift || shift.assignment?.freelancerId !== f.id) throw notFound('Keine Schicht von dir gefunden');
    if (shift.status !== 'COMPLETED') throw conflict('Bewerten ist erst nach Abschluss der Schicht möglich');
    const r = await tx.marketplaceShift.updateMany({ where: { id: shiftId, status: 'COMPLETED', restaurantRating: null }, data: { restaurantRating: rating } });
    if (r.count !== 1) throw conflict('Du hast diesen Betrieb für diese Schicht bereits bewertet');
    await tx.restaurant.update({ where: { id: shift.restaurantId }, data: { ratingSum: { increment: rating }, ratingCount: { increment: 1 } } });
  });
}

/** Der Betrieb lehnt einen Bewerber ab (ohne jemand anderen zu bestätigen); die Aushilfe wird informiert. */
export async function rejectApplication(userId: string, shiftId: string, freelancerId: string) {
  const shift = await prisma.marketplaceShift.findUnique({ where: { id: shiftId }, select: { restaurantId: true, status: true } });
  if (!shift) throw notFound('Schicht nicht gefunden');
  await assertRestaurantManager(userId, shift.restaurantId);
  const r = await prisma.shiftApplication.updateMany({ where: { shiftId, freelancerId, status: 'PENDING' }, data: { status: 'REJECTED', decidedAt: new Date() } });
  if (r.count !== 1) throw notFound('Keine offene Bewerbung');
  notifyNotSelected(shiftId, [freelancerId], 'DECLINED');
}
