#!/usr/bin/env bash
# Tägliches Datenbank-Backup (komprimierter pg_dump). Aufruf als root, z. B. per Cron:
#   0 3 * * * /opt/smartshift/deploy/backup.sh >> /var/log/smartshift-backup.log 2>&1
# Wiederherstellen:  gunzip -c /var/backups/smartshift/smartshift-XXXX.sql.gz | psql "$DATABASE_URL"
# WICHTIG: Der Dump enthält verschlüsselte Personendaten. Der Schlüssel (SSN_ENCRYPTION_KEY aus /etc/smartshift.env) gehört
# NICHT ins gleiche Backup, sondern getrennt gesichert (Passwortmanager) – ohne ihn sind SV-Nummern, Steuer-IDs und Nachweise unlesbar.
set -euo pipefail
ENV_FILE="${ENV_FILE:-/etc/smartshift.env}"
DEST="${BACKUP_DIR:-/var/backups/smartshift}"
KEEP_DAYS="${KEEP_DAYS:-14}"

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE fehlt"; exit 1; }
set -a; . "$ENV_FILE"; set +a
command -v pg_dump >/dev/null || { echo "pg_dump fehlt (apt install postgresql-client)"; exit 1; }

umask 077
mkdir -p "$DEST"
FILE="$DEST/smartshift-$(date +%Y%m%d-%H%M%S).sql.gz"
pg_dump --no-owner "$DATABASE_URL" | gzip > "$FILE"
[ -s "$FILE" ] || { echo "Backup ist leer – abgebrochen"; rm -f "$FILE"; exit 1; }
find "$DEST" -name 'smartshift-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) Backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
