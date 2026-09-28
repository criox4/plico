// Crash reports to Sentry (the web app and the phone apps; the server logs its own). Off unless VITE_SENTRY_DSN is set,
// and off when the person turns it off in Privacy and data. Nothing that identifies anyone is sent: no user, IP,
// cookies or bodies, and every event is scrubbed on the device first (emails and invite/claim/consent tokens live in
// Plico's addresses, e.g. #/f/<email>, #/claim/<token>).
import * as Sentry from '@sentry/capacitor'
import * as SentryReact from '@sentry/react'
import type { Breadcrumb, ErrorEvent, TransactionEvent } from '@sentry/core'
import { scrub } from './logic'

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined
const KEY = 'plico-crash-reports'
// ponytail: a per-device choice in WebView storage; if the OS clears that storage it falls back to on (the default).
export const crashReportsOn = () => { try { return localStorage.getItem(KEY) !== 'off' } catch { return true } }
export function setCrashReports(on: boolean) {
  try { on ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, 'off') } catch { /* storage blocked: stays as it was */ }
  if (on && !started) start()
  // Off: stop everything now, release-health pings included (they don't pass through beforeSend).
  if (!on && started) { started = false; void Sentry.close() }
}

let started = false
export function start() {
  if (!DSN || started || !crashReportsOn()) return
  started = true
  Sentry.init({
    dsn: DSN,
    release: `plico@${__APP_VERSION__}`,
    environment: import.meta.env.MODE,
    // Sentry's conservative settings: nothing about the person, no bodies, cookies or headers that could identify.
    dataCollection: { userInfo: false, httpBodies: [], cookies: false, httpHeaders: { request: false, response: false }, urlQueryParams: false },
    // Screen timings for a sample of loads. No trace headers to our API: it doesn't allow them, so CORS would fail.
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 0.1,
    tracePropagationTargets: [],
    // Checked again at send time, so turning the switch off takes effect at once.
    beforeSend: (e: ErrorEvent) => (crashReportsOn() ? scrub(e) : null),
    beforeSendTransaction: (e: TransactionEvent) => (crashReportsOn() ? scrub(e) : null),
    beforeBreadcrumb: (b: Breadcrumb) => (b.category === 'console' ? null : scrub(b)), // console lines can hold anything
  }, SentryReact.init)
}

export const ErrorBoundary = SentryReact.ErrorBoundary
