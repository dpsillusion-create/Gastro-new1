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

## E-Mail-Codes und Zwei-Faktor-Anmeldung
- **Registrierung:** Bestätigung der E-Mail-Adresse mit einem 6-stelligen Code.
- **Anmeldung:** Passwort + zweiter Faktor. Mit eingerichteter **Authenticator-App** (Google Authenticator, Microsoft Authenticator, Authy …)
  ist das der Code aus der App, sonst ein Code per E-Mail. Die App lässt sich im Bereich „Sicherheit“ einrichten (QR-Code); ohne App
  kann man sich jederzeit den Code per E-Mail schicken lassen.
- **Kosten:** keine SMS, keine externen Dienste – nur ein E-Mail-Postfach zum Versenden (SMTP).

Damit der Versand funktioniert, in `/etc/smartshift.env` eintragen (Vorlage: `backend/.env.example`):
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, danach `systemctl restart smartshift`.
Ohne diese Angaben kann sich in Produktion **niemand registrieren oder anmelden** (bewusst so, „fail closed“).

Zum Testen ohne E-Mail-Zugang: `NOTIFY_MODE=log` in `/etc/smartshift.env` – die Codes erscheinen dann in `journalctl -u smartshift -f`.
Nicht für echte Nutzer verwenden. Der E-Mail-Versand selbst ist bisher nur im Protokoll-Modus getestet.
`OTP_TEST_CODE` und `AUTH_RATE_LIMIT` sind für automatische Tests gedacht (`OTP_TEST_CODE` wird in Produktion ignoriert).
