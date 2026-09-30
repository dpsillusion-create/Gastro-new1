function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt`);
  return v;
}
export const config = {
  port: Number(process.env.PORT ?? 3000),
  get jwtSecret() { const v = required('JWT_SECRET'); if (v.length < 32) throw new Error('JWT_SECRET ist zu kurz (mindestens 32 Zeichen, z. B. `openssl rand -hex 32`)'); return v; },
  get ssnKey() {
    const key = Buffer.from(required('SSN_ENCRYPTION_KEY'), 'base64');
    if (key.length !== 32) throw new Error('SSN_ENCRYPTION_KEY muss 32 Byte (base64) sein');
    return key;
  },
};
/** Maximaler Suchradius (km) – Produktvorgabe. */
export const MAX_RADIUS_KM = 25;
export const DEFAULT_RADIUS_KM = 20;
/**
 * Gesetzlicher Mindestlohn in Cent/Stunde (2026: 13,90 €, ab 2027: 14,60 €).
 * Per Umgebungsvariable MIN_WAGE_CENTS anpassbar, wenn sich der Satz ändert.
 */
export const MIN_WAGE_CENTS = Number(process.env.MIN_WAGE_CENTS ?? 1390);
/** Version der Nutzungsbedingungen/Datenschutztexte, der Nutzer zugestimmt haben (bei Textänderung hochzählen). */
export const TERMS_VERSION = '2026-10';

/** Beim Start aufrufen: fehlerhafte Geheimnisse sofort melden statt erst bei der ersten Benutzung. */
export function validateConfig() {
  void config.jwtSecret; void config.ssnKey;
  if (process.env.NODE_ENV === 'production' && (process.env.NOTIFY_MODE ?? 'live') === 'live' && !(process.env.SMTP_HOST && process.env.MAIL_FROM))
    console.warn('[config] Achtung: SMTP_HOST/MAIL_FROM fehlen – Registrierung und Anmeldung können keine Codes verschicken (oder NOTIFY_MODE=log zum Testen setzen).');
  if (process.env.NOTIFY_MODE === 'log' && process.env.NODE_ENV === 'production')
    console.warn('[config] Achtung: NOTIFY_MODE=log – Bestätigungscodes stehen im Server-Protokoll. Nicht für echte Nutzer verwenden.');
}
