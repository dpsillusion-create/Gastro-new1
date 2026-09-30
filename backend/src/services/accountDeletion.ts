import { prisma } from '../db';
import { invalidateSessions } from '../middleware/auth';
import { encrypt } from './crypto';

/**
 * Löscht ein Konto im Sinne der DSGVO durch Anonymisierung: Kontaktdaten, Zugangsdaten, Dokumente und Profil werden entfernt.
 * Bereits erzeugte Melde-/Dienstplandatensätze (temporärer Mitarbeiter, Sofortmeldung) bleiben wegen gesetzlicher
 * Aufbewahrungspflichten erhalten, sind aber nicht mehr mit einem anmeldefähigen Konto verknüpft.
 * Betriebe: offene Schichten werden zurückgezogen und der Betrieb gesperrt.
 */
export async function anonymizeUser(userId: string) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, include: { freelancer: true, memberships: true } });
    if (user.freelancer) {
      const f = user.freelancer;
      await tx.hygieneCertificate.deleteMany({ where: { freelancerId: f.id } });
      await tx.shiftApplication.updateMany({ where: { freelancerId: f.id, status: 'PENDING' }, data: { status: 'WITHDRAWN', decidedAt: now } });
      await tx.freelancer.update({ where: { id: f.id }, data: {
        displayName: 'Gelöschter Nutzer', verified: false, verifiedSkills: [], claimedSkills: [],
        socialSecurityNumberEnc: encrypt(''), taxIdEnc: encrypt(''), birthDate: new Date('1900-01-01'),
        homeLatitude: null, homeLongitude: null, complianceValidatedAt: null,
      } });
    }
    for (const m of user.memberships.filter((x) => x.role === 'OWNER')) {
      await tx.marketplaceShift.updateMany({ where: { restaurantId: m.restaurantId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
      await tx.restaurant.update({ where: { id: m.restaurantId }, data: { blockedAt: now } });
      await tx.restaurantApiKey.updateMany({ where: { restaurantId: m.restaurantId, revokedAt: null }, data: { revokedAt: now } });
    }
    await tx.otpChallenge.deleteMany({ where: { userId } });
    await tx.user.update({ where: { id: userId }, data: {
      email: `geloescht-${userId}@deleted.invalid`, phone: null, passwordHash: null, totpSecretEnc: null, totpEnabledAt: null,
      isAdmin: false, deletedAt: now, sessionsValidFrom: now,
    } });
  });
  invalidateSessions(userId);
}
