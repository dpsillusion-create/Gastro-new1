#!/usr/bin/env bash
# SmartShift Swap – Deployment auf Debian/Ubuntu (z. B. Strato VServer). Als root ausführen.
# Voraussetzungen: Node.js >= 20, PostgreSQL erreichbar, /etc/smartshift.env angelegt (siehe deploy/README.md).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dpsillusion-create/gastro-new1.git}"
BRANCH="${BRANCH:-claude/cool-cray-gv7yoq}"
APP_DIR=/opt/smartshift
ENV_FILE=/etc/smartshift.env

git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE fehlt (Vorlage: backend/.env.example, chmod 600)"; exit 1; }
command -v node >/dev/null || { echo "Node.js >= 20 fehlt"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "Node.js >= 18 nötig (empfohlen: 20)"; exit 1; }
[ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ] || echo "Hinweis: Die Dienste laufen mit $(/usr/bin/node -v 2>/dev/null) – empfohlen ist Node 20 (siehe deploy/README.md)."

id smartshift >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin smartshift

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout -q "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
chown -R smartshift:smartshift "$APP_DIR"

cd "$APP_DIR/backend"
# Umgebungsvariablen (DATABASE_URL etc.) nur für diese Schritte laden
set -a; . "$ENV_FILE"; set +a
sudo -u smartshift --preserve-env=DATABASE_URL bash -c '
  npm ci &&
  npx prisma generate &&
  npx prisma migrate deploy &&
  npm run build'

install -m 644 "$APP_DIR/deploy/smartshift.service" /etc/systemd/system/smartshift.service
install -m 644 "$APP_DIR/deploy/smartshift-worker.service" /etc/systemd/system/smartshift-worker.service
systemctl daemon-reload
systemctl enable --now smartshift smartshift-worker
systemctl restart smartshift smartshift-worker
sleep 2
systemctl --no-pager --lines=5 status smartshift
# Gesundheitscheck: bis zu 30 Sekunden auf eine gesunde Antwort warten
PORT_NOW=$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2); ok=0
for i in $(seq 1 15); do
  if curl -fsS --max-time 3 "http://127.0.0.1:${PORT_NOW:-3000}/health" 2>/dev/null | grep -q '"database":"connected"'; then ok=1; break; fi; sleep 2
done
if [ "$ok" = 1 ]; then echo "✔ SmartShift läuft und die Datenbank ist verbunden."
else echo "✘ /health antwortet nicht – letzte Protokollzeilen:"; journalctl -u smartshift -n 25 --no-pager; exit 1; fi
echo "Version: $(git -C "$APP_DIR" log -1 --format='%h %s')"
echo "Fertig. Logs: journalctl -u smartshift -f"
