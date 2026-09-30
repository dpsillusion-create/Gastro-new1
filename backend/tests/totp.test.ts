import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, generateSecret, totpCode, verifyTotp } from '../src/services/totp';

// Testvektoren aus RFC 6238 (Anhang B), Secret "12345678901234567890", SHA-1 – die 8-stelligen Werte auf 6 Stellen gekürzt
const SECRET = base32Encode(Buffer.from('12345678901234567890'));
const at = (t: number) => totpCode(SECRET, Math.floor(t / 30));

describe('TOTP (RFC 6238)', () => {
  it('Base32 Hin- und Rückweg', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(SECRET).toString()).toBe('12345678901234567890');
  });
  it('liefert die Referenzcodes', () => {
    expect(at(59)).toBe('287082');
    expect(at(1111111109)).toBe('081804');
    expect(at(1234567890)).toBe('005924');
    expect(at(2000000000)).toBe('279037');
  });
  it('akzeptiert ±1 Schritt, lehnt weiter entfernte ab', () => {
    const now = 1234567890_000, step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(SECRET, totpCode(SECRET, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(SECRET, totpCode(SECRET, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(SECRET, totpCode(SECRET, step + 2), null, now)).toBeNull();
  });
  it('Replay: bereits verbrauchter Schritt wird abgelehnt', () => {
    const now = 1234567890_000, step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(SECRET, totpCode(SECRET, step), step, now)).toBeNull();
  });
  it('lehnt falsches Format ab; neue Secrets sind 32 Zeichen lang', () => {
    expect(verifyTotp(SECRET, 'abcdef', null)).toBeNull();
    expect(generateSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
});
