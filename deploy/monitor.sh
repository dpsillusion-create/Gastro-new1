#!/usr/bin/env bash
# Überwachung: prüft alle paar Minuten, ob SmartShift läuft, und schickt bei Störung bzw. Entwarnung eine E-Mail an ALERT_EMAIL
# (in /etc/smartshift.env setzen, z. B. ALERT_EMAIL=du@beispiel.de). Geprüft werden: /health (inkl. Datenbank), beide Dienste
# und der freie Speicherplatz. Erst nach 2 Fehlschlägen in Folge gibt es Alarm (kein Alarm wegen eines kurzen Neustarts).
# Einrichtung: bash deploy/install-cron.sh
set -u
ENV_FILE="${ENV_FILE:-/etc/smartshift.env}"
[ -f "$ENV_FILE" ] && { set -a; . "$ENV_FILE"; set +a; }
URL="${HEALTH_URL:-http://127.0.0.1:${PORT:-3000}/health}"
DIR="${STATE_DIR:-/var/tmp}"; FAILS="$DIR/smartshift-monitor.fails"; STATE="$DIR/smartshift-monitor.state"
APP="${APP_DIR:-/opt/smartshift}"

problems=""
body=$(curl -fsS --max-time 10 "$URL" 2>&1) || problems="$problems\n- /health nicht erreichbar: $body"
[ -z "$problems" ] && ! echo "$body" | grep -q '"database":"connected"' && problems="$problems\n- Datenbank nicht verbunden: $body"
if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
  for svc in smartshift smartshift-worker; do systemctl is-active --quiet "$svc" || problems="$problems\n- Dienst $svc läuft nicht"; done
fi
used=$(df --output=pcent / | tail -1 | tr -dc '0-9'); [ "${used:-0}" -ge 90 ] && problems="$problems\n- Speicherplatz knapp: ${used}% belegt"

prev=$(cat "$STATE" 2>/dev/null || echo ok)
send() { (cd "$APP/backend" && npx tsx scripts/alert.ts "$1" "$2") >/dev/null 2>&1 || echo "$(date -Is) Alarm nicht zustellbar: $1"; }

if [ -z "$problems" ]; then
  echo 0 > "$FAILS"
  if [ "$prev" = down ]; then echo ok > "$STATE"; send "Wieder erreichbar" "SmartShift läuft wieder ($(date -Is))."; echo "$(date -Is) wieder ok"; fi
else
  n=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAILS"
  echo "$(date -Is) Problem ($n):$(printf '%b' "$problems")"
  if [ "$n" -ge 2 ] && [ "$prev" != down ]; then echo down > "$STATE"; send "STÖRUNG" "$(printf 'Bei der Überwachung (%s) sind Probleme aufgefallen:%b\n\nLogs: journalctl -u smartshift -n 50' "$(date -Is)" "$problems")"; fi
fi
