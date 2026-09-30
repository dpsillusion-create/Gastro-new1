#!/usr/bin/env bash
# SmartShift Swap – Deployment auf Debian/Ubuntu (z. B. Strato VServer). Als root ausführen.
# Voraussetzungen: Node.js >= 20, PostgreSQL erreichbar, /etc/smartshift.env angelegt (siehe deploy/README.md).
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/dpsillusion-create/gastro-new1.git}"
BRANCH="${BRANCH:-claude/cool-cray-gv7yoq}"
APP_DIR=/opt/smartshift
ENV_FILE=/etc/smartshift.env

[ "$(id -u)" -eq 0 ] || { echo "Bitte als root ausführen"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "$ENV_FILE fehlt (Vorlage: backend/.env.example, chmod 600)"; exit 1; }
command -v node >/dev/null || { echo "Node.js >= 20 fehlt"; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js >= 20 nötig"; exit 1; }

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
echo "Fertig. Logs: journalctl -u smartshift -f"
