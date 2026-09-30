#!/usr/bin/env bash
# Richtet die regelmäßigen Aufgaben ein (idempotent – mehrfaches Ausführen ist unschädlich), als root:
#   - täglich 03:00 Datenbank-Backup   (deploy/backup.sh)
#   - alle 5 Minuten Überwachung        (deploy/monitor.sh, Alarm per E-Mail an ALERT_EMAIL)
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/smartshift}"
chmod +x "$APP_DIR/deploy/backup.sh" "$APP_DIR/deploy/monitor.sh"
command -v pg_dump >/dev/null || { echo "Hinweis: pg_dump fehlt – für das Backup: apt install -y postgresql-client"; }
current=$(crontab -l 2>/dev/null | grep -v 'smartshift-managed' || true)
{
  printf '%s\n' "$current"
  echo "0 3 * * * $APP_DIR/deploy/backup.sh >> /var/log/smartshift-backup.log 2>&1 # smartshift-managed"
  echo "*/5 * * * * $APP_DIR/deploy/monitor.sh >> /var/log/smartshift-monitor.log 2>&1 # smartshift-managed"
} | crontab -
echo "Zeitpläne eingerichtet:"; crontab -l | grep smartshift-managed
grep -q '^ALERT_EMAIL=' /etc/smartshift.env 2>/dev/null || echo "Hinweis: Für Alarm-E-Mails in /etc/smartshift.env ALERT_EMAIL=deine@adresse.de eintragen."
