import nodemailer from 'nodemailer';
import { HttpError } from '../errors';

export type Channel = 'EMAIL';

/**
 * Zustellung von Bestätigungscodes.
 *  NOTIFY_MODE=log  → Code nur ins Server-Protokoll (nur für Tests/Übergang! Wer das Protokoll lesen kann, sieht alle Codes.)
 *  NOTIFY_MODE=live → echter Versand per SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM).
 * Standard: in Produktion `live`, sonst `log`. Ist der Versand nicht konfiguriert, schlägt der Versand fehl (fail closed).
 */
const mode = () => process.env.NOTIFY_MODE ?? (process.env.NODE_ENV === 'production' ? 'live' : 'log');
const unavailable = () => new HttpError(503, 'DELIVERY_UNAVAILABLE', 'Der Versand des Bestätigungscodes ist derzeit nicht möglich. Bitte später erneut versuchen.');

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

export async function deliver(channel: Channel, to: string, text: string, subject = 'Dein Bestätigungscode – GastroEvolution'): Promise<void> {
  if (mode() === 'log') { console.warn(`[NOTIFY_MODE=log] ${channel} an ${to} [${subject}]: ${text}`); return; }
  try {
    {
      const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
      if (!SMTP_HOST || !MAIL_FROM) throw new Error('SMTP nicht konfiguriert');
      transport ??= nodemailer.createTransport({
        host: SMTP_HOST, port: Number(SMTP_PORT ?? 587), secure: Number(SMTP_PORT) === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      });
      await transport.sendMail({ from: MAIL_FROM, to, subject, text });
    }
  } catch (err) {
    console.error(`[notify] ${channel}-Versand fehlgeschlagen:`, (err as Error).message); // ohne Empfänger/Code im Protokoll
    throw unavailable();
  }
}
