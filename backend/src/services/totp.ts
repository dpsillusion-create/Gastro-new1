import { createHmac, randomBytes } from 'crypto';

/** TOTP nach RFC 6238 (HMAC-SHA1, 6 Stellen, 30-Sekunden-Schritte) – kompatibel mit Google/Microsoft Authenticator, Authy, 2FAS u. a. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) throw new Error('ungültiges Base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20)); // 160 Bit

/** Code für einen bestimmten 30-Sekunden-Schritt (HOTP mit Zähler = Schritt). */
export function totpCode(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}

/**
 * Prüft einen Code mit ±1 Schritt Toleranz (Uhrenabweichung). Gibt den passenden Schritt zurück oder null.
 * `lastStep`: bereits verbrauchte Schritte werden abgelehnt (ein Code gilt nur einmal).
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 1000 / STEP_SECONDS);
  for (const step of [current, current - 1, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (totpCode(secretB32, step) === code) return step;
  }
  return null;
}

export const otpauthUri = (email: string, secret: string) =>
  `otpauth://totp/GastroEvolution:${encodeURIComponent(email)}?secret=${secret}&issuer=GastroEvolution&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
