import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { OtpPurpose } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import { HttpError, unauthorized } from '../errors';
import { deliver } from './notify';

const TTL_MS = 10 * 60_000;      // Code 10 Minuten gültig
const MAX_ATTEMPTS = 5;          // danach verfällt der Code
const MAX_SENDS = 4;             // pro Nutzer/Zweck/Kanal
const SEND_WINDOW_MS = 15 * 60_000;

/** Nur außerhalb der Produktion: fester Code für automatische Tests. */
const fixedCode = () => (process.env.NODE_ENV === 'production' ? undefined : process.env.OTP_TEST_CODE);
const hash = (id: string, code: string) => createHmac('sha256', config.jwtSecret).update(`${id}:${code}`).digest('hex');

/** Erzeugt einen Code, speichert nur dessen Hash und versendet ihn. Ältere offene Codes desselben Kanals verfallen. */
export async function issueCode(user: { id: string; email: string; phone: string | null }, purpose: OtpPurpose, channel: 'EMAIL') {
  const recent = await prisma.otpChallenge.count({ where: { userId: user.id, purpose, channel, createdAt: { gt: new Date(Date.now() - SEND_WINDOW_MS) } } });
  if (recent >= MAX_SENDS) throw new HttpError(429, 'TOO_MANY', 'Zu viele Codes angefordert – bitte in einigen Minuten erneut versuchen');
  const to = user.email;
  const code = fixedCode() ?? String(randomInt(0, 1_000_000)).padStart(6, '0');
  const id = randomUUID();
  await prisma.otpChallenge.updateMany({ where: { userId: user.id, purpose, channel, consumedAt: null }, data: { consumedAt: new Date() } });
  await prisma.otpChallenge.create({ data: { id, userId: user.id, purpose, channel, codeHash: hash(id, code), expiresAt: new Date(Date.now() + TTL_MS) } });
  await deliver(channel, to, `Dein GastroEvolution-Code: ${code} (10 Minuten gültig). Gib ihn niemals weiter.`);
}

/** Prüft einen Code (zeitkonstant). Zählt Fehlversuche; nach MAX_ATTEMPTS ist der Code verbraucht. */
export async function checkCode(userId: string, purpose: OtpPurpose, channel: 'EMAIL', code: string): Promise<boolean> {
  const ch = await prisma.otpChallenge.findFirst({
    where: { userId, purpose, channel, consumedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' },
  });
  if (!ch) return false;
  const claim = await prisma.otpChallenge.updateMany({ where: { id: ch.id, attempts: { lt: MAX_ATTEMPTS }, consumedAt: null }, data: { attempts: { increment: 1 } } });
  if (claim.count !== 1) return false;
  const a = Buffer.from(hash(ch.id, code.trim())), b = Buffer.from(ch.codeHash);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) await prisma.otpChallenge.update({ where: { id: ch.id }, data: { consumedAt: new Date() } });
  return ok;
}

// --- kurzlebige "Zwischen"-Tokens (nach Passwort bzw. Registrierung, vor dem Code). Sie sind KEINE Sitzungstokens. ---
export function pendingToken(userId: string, purpose: 'signup' | 'login') {
  return jwt.sign({ sub: userId, typ: 'pending', purpose }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '30m' });
}
export function readPendingToken(token: string, purpose: 'signup' | 'login'): string {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof p === 'string' || p.typ !== 'pending' || p.purpose !== purpose || !p.sub) throw new Error();
    return p.sub;
  } catch { throw unauthorized('Sitzung abgelaufen – bitte erneut anmelden'); }
}
export const sessionToken = (userId: string) => jwt.sign({ sub: userId }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '8h' });

/** Nach der Registrierung: E-Mail-Bestätigungscode senden. Schlägt der Versand fehl, wird das Konto wieder entfernt. */
export async function startSignupVerification(user: { id: string; email: string; phone: string | null }) {
  try {
    await issueCode(user, 'SIGNUP', 'EMAIL');
  } catch (err) {
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    throw err;
  }
  return pendingToken(user.id, 'signup');
}
