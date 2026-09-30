import { prisma } from '../db';
import { badRequest } from '../errors';
import { encrypt } from './crypto';

const MIN_AGE_YEARS = 16;

/** Rentenversicherungsnummer: AABBBBBBCDDDP → Bereich(2) Geburtsdatum DDMMYY(6) Buchstabe(1) Serie(2) Prüfziffer(1). */
export function validateSocialSecurityNumber(raw: string, birthDate?: Date): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (!/^\d{8}[A-Z]\d{3}$/.test(s)) return false;
  // Geburtsdatum-Teil muss zum Profil passen (bei Namensänderung ändert sich nur der Buchstabe)
  if (birthDate) {
    const dd = String(birthDate.getUTCDate()).padStart(2, '0');
    const mm = String(birthDate.getUTCMonth() + 1).padStart(2, '0');
    const yy = String(birthDate.getUTCFullYear()).slice(-2);
    if (s.slice(2, 8) !== dd + mm + yy) return false;
  }
  // Buchstabe → zweistellige Position (A=01 … Z=26), danach gewichtete Quersumme mod 10
  const digits = s.slice(0, 8) + String(s.charCodeAt(8) - 64).padStart(2, '0') + s.slice(9, 11);
  const weights = [2, 1, 2, 5, 7, 1, 2, 1, 2, 1, 2, 1];
  const sum = [...digits].reduce((acc, ch, i) => {
    const p = Number(ch) * weights[i]!;
    return acc + Math.floor(p / 10) + (p % 10);
  }, 0);
  return sum % 10 === Number(s[11]);
}

/** Steuerliche Identifikationsnummer (11 Stellen, Prüfziffer nach ISO 7064 MOD 11,10). */
export function validateTaxId(raw: string): boolean {
  const s = raw.replace(/\s/g, '');
  if (!/^[1-9]\d{10}$/.test(s)) return false;
  let product = 10;
  for (let i = 0; i < 10; i++) {
    let sum = (Number(s[i]) + product) % 10;
    if (sum === 0) sum = 10;
    product = (2 * sum) % 11;
  }
  const check = 11 - product === 10 ? 0 : 11 - product;
  return check === Number(s[10]);
}

export function validateBirthDate(d: Date, now = new Date()): boolean {
  if (Number.isNaN(d.getTime()) || d >= now) return false;
  const min = new Date(Date.UTC(now.getUTCFullYear() - MIN_AGE_YEARS, now.getUTCMonth(), now.getUTCDate()));
  return d <= min && d.getUTCFullYear() > 1900;
}

/**
 * Speichert die Pflichtangaben verschlüsselt und setzt `complianceValidatedAt` nur, wenn ALLE
 * drei Felder formal gültig sind. Ungültige Eingaben werden abgelehnt und nicht gespeichert.
 */
export async function submitComplianceData(
  freelancerId: string, input: { socialSecurityNumber: string; taxId: string; birthDate: Date },
) {
  if (!validateBirthDate(input.birthDate)) throw badRequest('Geburtsdatum ungültig (Mindestalter 16)');
  if (!validateSocialSecurityNumber(input.socialSecurityNumber, input.birthDate))
    throw badRequest('Sozialversicherungsnummer ungültig oder passt nicht zum Geburtsdatum');
  if (!validateTaxId(input.taxId)) throw badRequest('Steuer-ID ungültig');
  await prisma.freelancer.update({
    where: { id: freelancerId },
    data: {
      socialSecurityNumberEnc: encrypt(input.socialSecurityNumber.replace(/\s/g, '').toUpperCase()),
      taxIdEnc: encrypt(input.taxId.replace(/\s/g, '')),
      birthDate: input.birthDate,
      complianceValidatedAt: new Date(),
    },
  });
}
