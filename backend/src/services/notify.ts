import nodemailer from 'nodemailer';
import { HttpError } from '../errors';

export type Channel = 'EMAIL' | 'SMS';

/**
 * Zustellung von Bestätigungscodes.
 *  NOTIFY_MODE=log  → Code nur ins Server-Protokoll (nur für Tests/Übergang! Wer das Protokoll lesen kann, sieht alle Codes.)
 *  NOTIFY_MODE=live → echter Versand: E-Mail über SMTP (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM),
 *                     SMS über Twilio (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM).
 * Standard: in Produktion `live`, sonst `log`. Ist ein Kanal nicht konfiguriert, schlägt der Versand fehl (fail closed).
 */
const mode = () => process.env.NOTIFY_MODE ?? (process.env.NODE_ENV === 'production' ? 'live' : 'log');
const unavailable = () => new HttpError(503, 'DELIVERY_UNAVAILABLE', 'Der Versand des Bestätigungscodes ist derzeit nicht möglich. Bitte später erneut versuchen.');

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;

export async function deliver(channel: Channel, to: string, text: string): Promise<void> {
  if (mode() === 'log') { console.warn(`[NOTIFY_MODE=log] ${channel} an ${to}: ${text}`); return; }
  try {
    if (channel === 'EMAIL') {
      const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
      if (!SMTP_HOST || !MAIL_FROM) throw new Error('SMTP nicht konfiguriert');
      transport ??= nodemailer.createTransport({
        host: SMTP_HOST, port: Number(SMTP_PORT ?? 587), secure: Number(SMTP_PORT) === 465,
        auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      });
      await transport.sendMail({ from: MAIL_FROM, to, subject: 'Dein Bestätigungscode – GastroEvolution', text });
    } else {
      const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
      if (!sid || !token || !from) throw new Error('SMS-Dienst nicht konfiguriert');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST', signal: AbortSignal.timeout(8000),
        headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: from, Body: text }),
      });
      if (!res.ok) throw new Error(`SMS-Dienst antwortet ${res.status}`);
    }
  } catch (err) {
    console.error(`[notify] ${channel}-Versand fehlgeschlagen:`, (err as Error).message); // ohne Empfänger/Code im Protokoll
    throw unavailable();
  }
}
