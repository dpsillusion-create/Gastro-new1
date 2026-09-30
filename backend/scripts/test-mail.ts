/**
 * Prüft den E-Mail-Versand (SMTP) und zeigt die genaue Fehlermeldung, falls etwas nicht stimmt.
 *   cd /opt/smartshift/backend && set -a && . /etc/smartshift.env && set +a
 *   npx tsx scripts/test-mail.ts empfaenger@beispiel.de
 */
import nodemailer from 'nodemailer';

const to = process.argv[2];
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;

async function main() {
  if (!to) throw new Error('Empfänger fehlt: npx tsx scripts/test-mail.ts empfaenger@beispiel.de');
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`In /etc/smartshift.env fehlt: ${missing.join(', ')}`);
  const port = Number(SMTP_PORT ?? 587);
  console.log(`Verbinde mit ${SMTP_HOST}:${port} als ${SMTP_USER} …`);
  const t = nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass: SMTP_PASS }, connectionTimeout: 10000 });
  await t.verify();
  console.log('✔ Verbindung und Anmeldung beim Mailserver erfolgreich');
  const info = await t.sendMail({ from: MAIL_FROM, to, subject: 'Testnachricht – GastroEvolution', text: 'Wenn du diese Nachricht liest, funktioniert der E-Mail-Versand von SmartShift Swap.' });
  console.log('✔ Testnachricht verschickt an', to, '–', info.response);
  console.log('Schau auch im Spam-Ordner nach, falls sie nicht im Posteingang ankommt.');
}
main().catch((e) => {
  console.error('✘ Fehler:', e.message);
  if (/EAUTH|Invalid login|535/.test(e.message)) console.error('→ Benutzername oder Passwort falsch. Bei Strato: die vollständige E-Mail-Adresse als Benutzer, das Postfach-Passwort.');
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(e.message)) console.error('→ Server nicht erreichbar: SMTP_HOST und SMTP_PORT prüfen (Strato: smtp.strato.de, Port 465) und ob die Firewall ausgehend Port 465/587 erlaubt.');
  if (/\b55[03]\b|sender (address )?rejected|not (owned|allowed)/i.test(e.message)) console.error('→ Absender abgelehnt: MAIL_FROM muss eine Adresse des angemeldeten Postfachs (bzw. Ihrer Domain) sein.');
  process.exit(1);
});
