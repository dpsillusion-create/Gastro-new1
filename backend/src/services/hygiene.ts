import { prisma } from '../db';
import { badRequest } from '../errors';
import { encryptBuffer } from './crypto';

export const MAX_CERT_BYTES = 5 * 1024 * 1024;

/** Dateityp an den Magic Bytes erkennen (nicht dem Client vertrauen). */
export function sniffMime(b: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/**
 * Speichert den Hygienenachweis verschlüsselt. Beim ERSTEN Upload wird das Profil automatisch freigeschaltet
 * (angegebene Fähigkeiten werden übernommen). Ein erneuter Upload ersetzt nur das Dokument – so lässt sich eine
 * manuell entzogene Freischaltung (scripts/admin.ts unverify) nicht durch erneutes Hochladen umgehen.
 */
export async function saveHygieneCertificate(freelancerId: string, base64: string, issuedOn: Date) {
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) throw badRequest('Datei ist leer');
  if (data.length > MAX_CERT_BYTES) throw badRequest('Datei zu groß (max. 5 MB)');
  const mime = sniffMime(data);
  if (!mime) throw badRequest('Nur JPG, PNG oder PDF erlaubt');
  const now = new Date(), tenYearsAgo = new Date(Date.UTC(now.getUTCFullYear() - 10, now.getUTCMonth(), now.getUTCDate()));
  if (Number.isNaN(issuedOn.getTime()) || issuedOn > now || issuedOn < tenYearsAgo) throw badRequest('Ausstellungsdatum ungültig');

  await prisma.$transaction(async (tx) => {
    const existing = await tx.hygieneCertificate.findUnique({ where: { freelancerId }, select: { id: true } });
    const fields = { mimeType: mime, dataEnc: encryptBuffer(data), issuedOn, uploadedAt: now };
    await tx.hygieneCertificate.upsert({ where: { freelancerId }, create: { freelancerId, ...fields }, update: fields });
    if (!existing) {
      const f = await tx.freelancer.findUniqueOrThrow({ where: { id: freelancerId }, select: { claimedSkills: true } });
      await tx.freelancer.update({ where: { id: freelancerId }, data: { verified: true, verifiedSkills: f.claimedSkills } });
    }
  });
}
