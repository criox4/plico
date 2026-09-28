# Plico observability (self-hosted LGTM)

Grafana, Loki (logs), Tempo (traces) and Prometheus (metrics), fed by Grafana Alloy. Runs on a separate server, not next to
the API, so it still sees (and reports) the API going down.

| What | Where |
|---|---|
| Host | A separate Linux server · 2 cores / 4 GB / 40 GB · Docker |
| Files | `/opt/plico-obs` (this folder) · secrets in `/opt/plico-obs/.env` (mode 600, never committed) |
| Grafana | https://grafana.example.com (behind your sign-in proxy) · LAN: http://<stack-host>:3000 |
| Telemetry in | https://otlp.example.com/v1/{traces,metrics,logs} · bearer token (`OTLP_TOKEN`) · 5 MB max |
| Path | Your reverse proxy (TLS) → Alloy :4318 → Tempo / Loki / Prometheus |

Kept: logs 30 days, traces 7 days, metrics 30 days. Memory is capped per service (about 3.3 GB in total).

## The API side
Set on the API server (see `server/otel.ts`); without them telemetry is off:
```
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <OTLP_TOKEN from /opt/plico-obs/.env>
```
Requests are named by route pattern, outgoing calls keep only their host, and log lines are scrubbed (emails,
invite/claim tokens) before they leave the API.

## What's in Grafana
- **Plico API** dashboard: up (checked from home), requests, 5xx rate, p95 by route, push deliveries and backlog,
  Ask Plico questions and tools, receipts read, emails, and error/warning logs (each links to its trace).
- **Alerts** (`grafana/provisioning/alerting/rules.yaml`): API down (critical), telemetry stopped (critical),
  5xx above 5%, p95 above 2 s, push backlog over 50.

## Alerts to your phone
Until contact points exist, alerts show in Grafana only.
1. Telegram: message @BotFather → `/newbot` → token. Send your bot a message, then open
   `https://api.telegram.org/bot<token>/getUpdates` and copy `chat.id`.
2. WhatsApp (critical only): follow https://www.callmebot.com/blog/free-api-whatsapp-messages/ to get an API key, then
   `CALLMEBOT_URL=https://api.callmebot.com/whatsapp.php?phone=<+91…>&apikey=<key>&text=Plico+alert`.
3. Add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `CALLMEBOT_URL` to `.env`, copy
   `contactpoints.yaml.example` to `contactpoints.yaml`, and `docker compose up -d`.

## Everyday
```sh
ssh <stack-host>
cd /opt/plico-obs
docker compose ps                  # all five Up
docker compose logs -f alloy       # what's arriving
docker compose pull && docker compose up -d   # after bumping an image tag here
```
Changing a config here: copy the file to the same path under `/opt/plico-obs`, then `docker compose up -d` (or
`restart <service>`). Check YAML before copying: a bad alert file stops Grafana from starting.

`PLICO_HEALTH_URL` in `.env` is what "API up" checks; point it at the production API's `/health` once deployed.
