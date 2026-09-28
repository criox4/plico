# Plico observability (self-hosted LGTM)

Grafana, Loki (logs), Tempo (traces) and Prometheus (metrics), fed by Grafana Alloy; WAHA for WhatsApp alerts. Runs on a separate server, not next to
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
Routing (`grafana/provisioning/alerting/contactpoints.yaml`): everything → Telegram; `severity=critical` → Telegram
and WhatsApp.
- **Telegram:** a bot from @BotFather. `TELEGRAM_BOT_TOKEN` in `.env`; `TELEGRAM_CHAT_ID` from
  `https://api.telegram.org/bot<token>/getUpdates` after sending the bot `/start`.
- **WhatsApp:** the `waha` service ([WAHA](https://waha.devlike.pro), NOWEB engine), internal to this compose network
  and called by Grafana's webhook with `X-Api-Key: $WAHA_API_KEY` and a custom JSON payload. A **spare number** is linked
  as a WhatsApp linked device (sender); `WHATSAPP_ALERT_TO` is the full chat id it sends to: a group (`…@g.us`, joined
  with `POST /api/default/groups/join {"code": "<invite code>"}`) or a person (`<number>@c.us`). Unofficial client, so
  use a number you can afford to lose.
- **Linking the spare phone:** `POST /api/sessions {"name":"default","start":true}`, then fetch
  `GET /api/default/auth/qr` (`Accept: image/png`) and scan it (WhatsApp → Linked devices). The QR rotates about every
  20 s, so refresh it until `GET /api/sessions/default` says `WORKING`. All calls from inside the network, e.g.
  `docker compose exec -T grafana wget -qO- --header "X-Api-Key: $K" http://waha:3000/…`.
- **Test:** Alerting → Contact points → Test, or the API
  `POST /apis/notifications.alerting.grafana.app/v1beta1/namespaces/default/receivers/<id>/test` (Grafana 13).

The contact points need all four values in `.env` before Grafana starts: a contact point missing its token (or a chat
id that expands to a bare number) stops Grafana from starting.

## Everyday
```sh
ssh <stack-host>
cd /opt/plico-obs
docker compose ps                  # all six Up
docker compose logs -f alloy       # what's arriving
docker compose pull && docker compose up -d   # after bumping an image tag here
```
Changing a config here: copy the file to the same path under `/opt/plico-obs`, then `docker compose up -d` (or
`restart <service>`). Check YAML before copying: a bad alert file stops Grafana from starting.

`GRAFANA_URL` (its public address) and `GRAFANA_PROXY_IP` (the sign-in proxy allowed to pass `Remote-User`) in `.env`
configure Grafana. `PLICO_HEALTH_URL` in `.env` is what "API up" checks; point it at the production API's `/health` once deployed.
