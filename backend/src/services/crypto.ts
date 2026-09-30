import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { config } from '../config';

/** AES-256-GCM; Format: base64(iv[12] | tag[16] | ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.ssnKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

export function decrypt(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const d = createDecipheriv('aes-256-gcm', config.ssnKey, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

/** Binärdaten (z. B. Dokumente): AES-256-GCM, Format iv[12] | tag[16] | ciphertext. */
export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', config.ssnKey, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]);
}
export function decryptBuffer(buf: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', config.ssnKey, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]);
}
