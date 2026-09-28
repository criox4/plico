# Observability: logs, traces, metrics, crash reports

Plico reports on itself in two places:

| What | Where | Code |
|---|---|---|
| **Server**: request traces, metrics, logs | Self-hosted Grafana (LGTM) at **https://grafana.example.com** | `server/otel.ts` |
| **App** (web, iOS, Android): crashes and screen timings | Sentry (EU), project `criox4/capacitor` | `src/sentry.ts` |

The stack itself (hosting, configs, alert routing) is in `ops/observability/`; its README covers running it.

## Connecting the API
Telemetry is off unless these are set in the API's environment:
```sh
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <OTLP_TOKEN>   # from /opt/plico-obs/.env on the stack's host
```
- These are the standard OpenTelemetry variables. Pointing them at any other OTLP/HTTP backend works without code changes (Grafana Cloud, Better Stack, a local collector).
- The endpoint accepts only `/v1/traces`, `/v1/metrics` and `/v1/logs` with the token; anything else gets 401 or 404.
- **Locally:** set the two variables before `npm run server`. On a Mac with Cloudflare WARP, a hostname created moments ago can stay cached as "not found" by macOS for a while. `dig` works but Node doesn't; it clears on its own, or with `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`.
- `server/otel.ts` is the first import in `server/index.ts`, so instrumentation is in place before anything else loads. Keep it first.

## What the API sends
- **Traces:** one span per API request, named by route pattern (`GET /api/groups/:gid/expenses/:eid`), with Prisma queries and outgoing HTTP calls (OpenRouter, Jev, FCM, …) as children. The push worker's passes are traced as `push.flush`.
- **Metrics:**
  - `http_server_request_duration_seconds{http_route, http_request_method, http_response_status_code}`: counts, rates and latency percentiles.
  - `plico_push_deliveries_total{channel, result}`
  - `plico_push_pending`: notifications due and not yet sent.
  - `plico_chat_turns_total{result}`, `plico_chat_tools_total{tool}`
  - `plico_ai_reads_total{result}`
  - `plico_email_sent_total{result}`
- **Logs:** every `console.log/info/warn/error` line, with its severity, linked to the trace of the request that wrote it.

## Privacy rules (keep them when adding anything)
1. **Never the real path.** Spans and metrics use the matched route pattern. Paths carry emails (`/f/<email>`) and secret tokens (`/claim/<token>`, `/invites/<code>`).
2. **Outgoing calls keep only their host.** Web-push endpoint URLs are secrets in themselves.
3. **Logs are scrubbed** with `scrub()` from `src/logic.ts`, the same function the app's crash reports use: emails and the segment after token-bearing paths become `[email]` / `[hidden]`.
4. **No user identity** in attributes or labels: no user ids, emails, names, amounts or message text. Label values should come from a short, fixed list (route, status, channel, result), never from user input. That's also what keeps Prometheus fast.

## Adding a metric
Use the counters in `server/otel.ts` (`count.push`, `count.chat`, …), or add one there:
```ts
// server/otel.ts
export const count = { …, settle: meter.createCounter('plico.settlements', { description: 'Settlements recorded, by result' }) }
// where it happens
count.settle.add(1, { result: pending ? 'pending' : 'confirmed' })
```
It appears in Prometheus as `plico_settlements_total` within about 30 seconds. Counters are no-ops when telemetry is off, so they cost nothing in development.

## Looking at it
- **Dashboard "Plico API"** (folder Plico):
  - health, checked from outside the API's host (so it notices the API's host being down);
  - request rate, 5xx share, p95 by route;
  - push, Ask Plico, AI reads, email;
  - error and warning logs.
- **Explore → Tempo:** `{resource.service.name="plico-api" && span.http.route="/api/chat"}`. Open a trace to see its database queries and outgoing calls, then "Logs for this span".
- **Explore → Loki:** `{service_name="plico-api"} | severity_text="ERROR"`.
- **Explore → Prometheus:** `histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))`.

## Alerts
Defined in `ops/observability/grafana/provisioning/alerting/rules.yaml`:

| Alert | Fires when | Goes to |
|---|---|---|
| API is down | `/health` fails from outside the API's host for 2 min | Telegram + WhatsApp group “Grafana Alerts” |
| API telemetry stopped | no data from the API for 10 min | Telegram + WhatsApp group |
| Server errors above 5% | for 10 min | Telegram |
| API is slow | p95 over 2 s for 15 min | Telegram |
| Push notifications stuck | over 50 waiting for 15 min | Telegram |

Change a threshold in the file, copy it to the stack's host and restart Grafana. Check the YAML first: a broken file stops Grafana from starting.

## Crash reports (the app)
`src/sentry.ts`, on when `VITE_SENTRY_DSN` is set at build time. People can turn it off under You › Privacy and data. Events are scrubbed on the device with the same `scrub()`. Source maps upload only with `SENTRY_AUTH_TOKEN` set. See the Sentry section in `PLAN.md`.
