import type { MarketplaceShift } from '@prisma/client';
import { conflict } from '../errors';
import type { Tx } from '../db';
import { encrypt } from '../services/crypto';
import { buildDeuevData } from '../services/deuev';
import { enqueueEvent, SOFORTMELDUNG_EVENT } from '../services/webhooks';

/**
 * Integrations-Hook: wird INNERHALB der Accept-Transaktion aufgerufen. Schlägt er fehl,
 * wird das komplette Match zurückgerollt – es gibt nie ein Match ohne Dienstplan-/Zeiterfassungseintrag.
 *
 * Idempotent: `shiftId` ist UNIQUE auf TemporaryEmployee, ein zweiter Aufruf ändert nichts.
 * Zum Anbinden der echten Module nur diese Funktion (bzw. das Port-Interface) austauschen.
 */
export async function onShiftMatched(tx: Tx, shift: MarketplaceShift, freelancerId: string) {
  const existing = await tx.temporaryEmployee.findUnique({ where: { shiftId: shift.id } });
  if (existing) return existing;

  const f = await tx.freelancer.findUniqueOrThrow({ where: { id: freelancerId } });
  const restaurant = await tx.restaurant.findUniqueOrThrow({ where: { id: shift.restaurantId } });
  // Ohne validierte Compliance-Daten ist die gesetzliche Sofortmeldung nicht möglich → Match verweigern.
  if (!f.complianceValidatedAt) throw conflict('Compliance-Daten des Freelancers nicht validiert');

  // 1) Temporärer Mitarbeiter, gültig exakt für den Schichtzeitraum (Zeiterfassungsterminal)
  const temp = await tx.temporaryEmployee.create({
    data: {
      restaurantId: shift.restaurantId, freelancerId, shiftId: shift.id,
      validFrom: shift.startTime, validUntil: shift.endTime,
    },
  });

  // 2) Dienstplan-Eintrag
  await tx.rosterEntry.create({
    data: {
      restaurantId: shift.restaurantId, temporaryEmployeeId: temp.id, role: shift.role,
      startTime: shift.startTime, endTime: shift.endTime, hourlyRateCents: shift.hourlyRateCents,
    },
  });

  // 3) Sofortmeldung: DEÜV-Daten verschlüsselt ablegen (Beschäftigungsbeginn = Schichtbeginn)
  const { data, missing } = buildDeuevData(f, shift, restaurant);
  const notification = await tx.immediateNotification.create({
    data: {
      temporaryEmployeeId: temp.id, payloadEnc: encrypt(JSON.stringify(data)),
      status: missing.length ? 'NEEDS_DATA' : 'READY', missingFields: missing,
    },
  });

  // 4) Webhook-Event (Outbox, gleiche Transaktion): stößt die Generierung/den Export der Meldung an.
  //    Payload nur mit IDs – Personendaten werden ausschließlich über den autorisierten Export-Endpunkt abgerufen.
  await enqueueEvent(tx, SOFORTMELDUNG_EVENT, {
    shiftId: shift.id, restaurantId: shift.restaurantId, temporaryEmployeeId: temp.id,
    immediateNotificationId: notification.id, ready: missing.length === 0, missingFields: missing,
  });
  return temp;
}
