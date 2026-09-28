// OpenTelemetry for the API: traces, metrics and logs to the observability stack (ops/observability). Off unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set; the token rides in OTEL_EXPORTER_OTLP_HEADERS ("Authorization=Bearer …").
// Imported first by index.ts. Privacy: requests are named by their route pattern (/api/groups/:gid), never the real
// path (it can hold emails and tokens); outgoing calls keep only their host (push endpoints are secrets themselves);
// every log line passes the same scrub() as the app's crash reports.
import { format } from 'node:util'
import { SpanKind, SpanStatusCode, metrics, trace, type Span } from '@opentelemetry/api'
import { SeverityNumber, logs } from '@opentelemetry/api-logs'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { PrismaInstrumentation } from '@prisma/instrumentation'
import type { MiddlewareHandler } from 'hono'
import { scrub } from '../src/logic.ts'
import pkg from '../package.json' with { type: 'json' }

const on = !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT
if (on) {
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({ 'service.name': 'plico-api', 'service.version': pkg.version, 'deployment.environment.name': process.env.NODE_ENV ?? 'development' }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 30_000 })],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
    instrumentations: [
      new UndiciInstrumentation({ requestHook: (span: Span, req: { origin: string }) => span.setAttribute('url.full', req.origin) }),
      new PrismaInstrumentation(),
    ],
  })
  sdk.start()
  const stop = () => void sdk.shutdown().catch(() => {})
  process.once('SIGTERM', stop); process.once('SIGINT', stop)

  // Every console line also goes to Loki (scrubbed), tied to the request's trace when there is one.
  const logger = logs.getLogger('plico-api')
  const levels = { error: SeverityNumber.ERROR, warn: SeverityNumber.WARN, info: SeverityNumber.INFO, log: SeverityNumber.INFO } as const
  for (const level of Object.keys(levels) as (keyof typeof levels)[]) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      try { logger.emit({ severityNumber: levels[level], severityText: level === 'log' ? 'INFO' : level.toUpperCase(), body: scrub(format(...args)) }) } catch { /* never let logging break a request */ }
    }
  }
}

const tracer = trace.getTracer('plico-api')
const meter = metrics.getMeter('plico-api')
const duration = meter.createHistogram('http.server.request.duration', {
  unit: 's', description: 'API request time',
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
})

/** A span and a timing per API request, named by the matched route pattern. */
export const httpTelemetry: MiddlewareHandler = async (c, next) => {
  if (!on) return next()
  const start = performance.now()
  return tracer.startActiveSpan(c.req.method, { kind: SpanKind.SERVER }, async span => {
    try {
      await next()
    } catch (e) {
      span.recordException(e as Error); throw e
    } finally {
      // The most specific pattern that matched: catch-all middleware (/api/*) is listed too, often last.
      const paths = c.req.matchedRoutes.map(r => r.path)
      const route = paths.filter(p => !p.endsWith('*')).at(-1) ?? paths.at(-1) ?? 'unmatched'
      const status = c.res.status
      const attrs = { 'http.request.method': c.req.method, 'http.route': route, 'http.response.status_code': status }
      span.updateName(`${c.req.method} ${route}`)
      span.setAttributes(attrs)
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
      span.end()
      duration.record((performance.now() - start) / 1000, attrs)
    }
  })
}

/** Business counters, for the dashboards and alerts (no-ops when telemetry is off). */
export const count = {
  push: meter.createCounter('plico.push.deliveries', { description: 'Push notifications sent, by channel and result' }),
  chat: meter.createCounter('plico.chat.turns', { description: 'Ask Plico questions, by outcome' }),
  tool: meter.createCounter('plico.chat.tools', { description: 'Ask Plico tool calls, by tool' }),
  ai: meter.createCounter('plico.ai.reads', { description: 'Receipts and sentences read, by outcome' }),
  email: meter.createCounter('plico.email.sent', { description: 'Emails, by outcome' }),
}
/** Notifications waiting to go out: a stuck worker shows up as this climbing. Set by push.ts. */
export const gauge = { pushPending: meter.createObservableGauge('plico.push.pending', { description: 'Notifications due and not yet sent' }) }
/** A span around background work (the push worker's passes). */
export const traced = <T>(name: string, fn: () => Promise<T>) => (on ? tracer.startActiveSpan(name, async span => {
  try { return await fn() } catch (e) { span.recordException(e as Error); span.setStatus({ code: SpanStatusCode.ERROR }); throw e } finally { span.end() }
}) : fn())
