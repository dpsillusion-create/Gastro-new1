import { randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** Format: scrypt$<salt b64>$<hash b64> (scrypt-Parameter = Node-Standard, N=16384). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Auch bei unbekanntem Nutzer rechnen wir einen Hash → gleiche Antwortzeit (kein User-Enumeration-Timing)
  const [, saltB64, hashB64] = (stored ?? DUMMY).split('$');
  const expected = Buffer.from(hashB64!, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64!, 'base64'), expected.length);
  return timingSafeEqual(actual, expected) && stored !== null;
}
const DUMMY = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;
