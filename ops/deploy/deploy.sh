#!/usr/bin/env bash
# Run on the API host by the deploy workflow: bash /opt/plico/deploy.sh <image-tag>
# Pulls the image, restarts, waits for /health, and goes back to the previous tag if it never gets healthy.
set -euo pipefail
cd /opt/plico
new=$1
old=$(cat .tag 2>/dev/null || echo latest)

up() { TAG=$1 docker compose pull -q && TAG=$1 docker compose up -d --remove-orphans; }
healthy() { for _ in $(seq 30); do curl -fsS -m 2 http://127.0.0.1:8787/health >/dev/null && return 0; sleep 2; done; return 1; }

up "$new"
if healthy; then
  echo "$new" > .tag
  docker image prune -f >/dev/null
  echo "deployed $new"
else
  echo "$new never became healthy; rolling back to $old" >&2
  docker compose logs --tail 50 api >&2 || true
  up "$old"
  exit 1
fi
