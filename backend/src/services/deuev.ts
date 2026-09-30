import type { Freelancer, MarketplaceShift, Restaurant } from '@prisma/client';
import { decrypt } from './crypto';

/** Personengruppenschlüssel 110 = kurzfristig Beschäftigte. Vor Produktivbetrieb mit Steuerberater/DEÜV-Leitfaden prüfen. */
const PERSONENGRUPPE_KURZFRISTIG = '110';
const MELDEGRUND_SOFORTMELDUNG = '20';

export interface DeuevData {
  meldegrund: string; personengruppe: string; betriebsnummerArbeitgeber: string | null;
  versicherungsnummer: string; steuerId: string; geburtsdatum: string; name: string;
  beschaeftigungsbeginn: string; taetigkeitsschluessel: string | null; ort: string;
}

/** Baut die (unverschlüsselten!) DEÜV-Meldedaten; Ausgabe nur an autorisierte Arbeitgeber-Endpunkte. */
export function buildDeuevData(f: Freelancer, s: MarketplaceShift, r: Restaurant): { data: DeuevData; missing: string[] } {
  const data: DeuevData = {
    meldegrund: MELDEGRUND_SOFORTMELDUNG, personengruppe: PERSONENGRUPPE_KURZFRISTIG,
    betriebsnummerArbeitgeber: r.employerBetriebsnummer,
    versicherungsnummer: decrypt(f.socialSecurityNumberEnc), steuerId: decrypt(f.taxIdEnc),
    geburtsdatum: f.birthDate.toISOString().slice(0, 10), name: f.displayName,
    beschaeftigungsbeginn: s.startTime.toISOString(), taetigkeitsschluessel: s.activityKey, ort: r.city,
  };
  const missing: string[] = [];
  if (!data.betriebsnummerArbeitgeber || !/^\d{8}$/.test(data.betriebsnummerArbeitgeber)) missing.push('betriebsnummerArbeitgeber');
  if (!data.taetigkeitsschluessel || !/^\d{9}$/.test(data.taetigkeitsschluessel)) missing.push('taetigkeitsschluessel');
  return { data, missing };
}
