import { Prisma, Skill } from '@prisma/client';
import { prisma } from '../db';
import { conflict, forbidden, notFound } from '../errors';
import { onShiftMatched } from '../integrations/timeTracking';
import { assertComplianceValidated, assertRestaurantManager } from '../middleware/auth';
import { dispatchPendingWebhooks } from './webhooks';
import { boundingBox } from './geo';

export interface CreateShiftInput {
  restaurantId: string; role: string; requiredSkill: Skill; requirements?: string;
  hourlyRateCents: number; startTime: Date; endTime: Date; activityKey?: string;
}

/** Wirt schreibt eine Schicht aus. Geo-Koordinaten kommen vom Restaurant (nie vom Client). */
export async function createShift(userId: string, input: CreateShiftInput) {
  await assertRestaurantManager(userId, input.restaurantId);
  const r = await prisma.restaurant.findUnique({ where: { id: input.restaurantId } });
  if (!r) throw notFound('Restaurant nicht gefunden');
  return prisma.marketplaceShift.create({
    data: { ...input, latitude: r.latitude, longitude: r.longitude, createdById: userId },
  });
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
             s."startTime", s."endTime", r.name AS "restaurantName", r.city,
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
        AND NOT EXISTS (SELECT 1 FROM "ShiftApplication" a
                        WHERE a."shiftId" = s.id AND a."freelancerId" = ${i.freelancerId})
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
  return prisma.shiftApplication.upsert({
    where: { shiftId_freelancerId: { shiftId, freelancerId: freelancer.id } },
    create: { shiftId, freelancerId: freelancer.id },
    update: {},
  });
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
    await tx.shiftApplication.updateMany({
      where: { shiftId, id: { not: app.id }, status: 'PENDING' },
      data: { status: 'REJECTED', decidedAt: now },
    });

    const temp = await onShiftMatched(tx, { ...shift, status: 'MATCHED' }, freelancerId);
    return { shiftId, status: 'MATCHED' as const, temporaryEmployeeId: temp.id };
  }, { isolationLevel: 'Serializable' });
  // Nach dem Commit: Webhook sofort zustellen (Fire-and-forget; bei Fehler übernimmt der Retry-Worker)
  void dispatchPendingWebhooks().catch(console.error);
  return result;
}
