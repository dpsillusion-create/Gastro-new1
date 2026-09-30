/**
 * Schickt eine Alarm-E-Mail an ALERT_EMAIL (SMTP-Daten wie in /etc/smartshift.env).
 *   npx tsx scripts/alert.ts "Betreff" "Text"
 * Wird von deploy/monitor.sh aufgerufen.
 */
import nodemailer from 'nodemailer';

const [subject, text] = process.argv.slice(2);
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, ALERT_EMAIL } = process.env;

async function main() {
  if (!ALERT_EMAIL) { console.log('ALERT_EMAIL nicht gesetzt – nur Protokoll:', subject); return; }
  if (!SMTP_HOST || !MAIL_FROM) throw new Error('SMTP_HOST/MAIL_FROM fehlen');
  const port = Number(SMTP_PORT ?? 587);
  const t = nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined, connectionTimeout: 10000 });
  await t.sendMail({ from: MAIL_FROM, to: ALERT_EMAIL, subject: `[SmartShift] ${subject}`, text: `${text ?? ''}\n\n–\nautomatische Nachricht von deploy/monitor.sh` });
  console.log('Alarm verschickt an', ALERT_EMAIL);
}
main().catch((e) => { console.error('Alarm konnte nicht verschickt werden:', e.message); process.exit(1); });
