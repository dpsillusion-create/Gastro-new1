# Deployment auf dem Strato-Linux-Server (Debian/Ubuntu)

Alle Schritte laufen **auf dem Server**, per SSH als root (oder mit sudo).

## 1. Einmalig: Software
```bash
apt update && apt install -y git postgresql nginx certbot python3-certbot-nginx
# Node.js 20 (falls noch nicht vorhanden): https://github.com/nodesource/distributions
node -v   # muss >= 20 sein
```

## 2. Einmalig: Datenbank
```bash
sudo -u postgres psql <<SQL
CREATE USER smartshift WITH PASSWORD 'HIER_STARKES_PASSWORT';
CREATE DATABASE smartshift OWNER smartshift;
SQL
```

## 3. Einmalig: Konfiguration `/etc/smartshift.env`
```bash
cat > /etc/smartshift.env <<ENV
DATABASE_URL=postgresql://smartshift:HIER_STARKES_PASSWORT@localhost:5432/smartshift
JWT_SECRET=$(openssl rand -hex 32)
SSN_ENCRYPTION_KEY=$(openssl rand -base64 32)
PORT=3000
# optional: WEBHOOK_URL=... und WEBHOOK_SECRET=...
ENV
chmod 600 /etc/smartshift.env
```
**Wichtig:** `SSN_ENCRYPTION_KEY` sichern (Passwortmanager/Backup). Ohne ihn sind die verschlüsselten SV-Nummern und
Steuer-IDs unwiederbringlich verloren. `JWT_SECRET` muss zu dem des bestehenden GastroEvolution-Auth-Service passen.

## 4. Deployen (und für jedes spätere Update erneut)
```bash
git clone https://github.com/dpsillusion-create/gastro-new1.git /tmp/gn && bash /tmp/gn/deploy/deploy.sh
```
Bei privatem Repo: vorher einen Deploy-Key oder Token einrichten. Anderer Branch: `BRANCH=main bash deploy.sh`.

## 5. nginx + HTTPS
```bash
cp /opt/smartshift/deploy/nginx-smartshift.conf /etc/nginx/sites-available/smartshift
# server_name ist bereits jobs.gastroevolution.de
ln -s /etc/nginx/sites-available/smartshift /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d jobs.gastroevolution.de
```

## Prüfen
`journalctl -u smartshift -f` · `curl -i http://127.0.0.1:3000/api/v1/marketplace/search` → erwartet `401`.

## Nach dem Start noch einrichten
- Der Worker (`smartshift-worker`, No-Show-Erkennung und Webhook-Retry) wird von `deploy.sh` mitinstalliert: `journalctl -u smartshift-worker -f`.
- Regelmäßige, verschlüsselte Datenbank-Backups (`pg_dump`).
- Firewall: nur 22, 80, 443 offen; Port 3000 nicht öffentlich.

## Bestätigungscodes und Zwei-Faktor-Anmeldung (SMS + E-Mail)
Registrierung und Anmeldung verlangen Codes per E-Mail und SMS. Ohne Zugangsdaten für den Versand kann sich in Produktion
**niemand registrieren oder anmelden** (bewusst: „fail closed“). Zwei Wege:

1. **Echter Versand** – in `/etc/smartshift.env` eintragen (Vorlage: `backend/.env.example`):
   `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` sowie `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.
   Danach `systemctl restart smartshift`.
2. **Übergangsweise zum Testen:** `NOTIFY_MODE=log` in `/etc/smartshift.env`. Die Codes erscheinen dann in `journalctl -u smartshift -f`.
   Nicht für echte Nutzer verwenden.

Der Versand ist bisher nur im Protokoll-Modus getestet (keine Zugangsdaten vorhanden). Beim ersten echten Versand bitte einmal selbst
registrieren und anmelden. `OTP_TEST_CODE` ist nur für automatische Tests gedacht und wird in Produktion ignoriert.
