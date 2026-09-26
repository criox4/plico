// Who's calling, for rate limits. Clients can send any header they like, so only two sources are trusted: the header
// our own proxy sets (CLIENT_IP_HEADER, e.g. fly-client-ip, cf-connecting-ip, or x-real-ip from nginx), or else the
// TCP connection's address. Never x-forwarded-for as sent: its leftmost value is whatever the client wrote.
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'

const HEADER = process.env.CLIENT_IP_HEADER?.trim().toLowerCase()
/** Better Auth reads the client IP from this header, which we set on every request after dropping any sent value. */
export const IP_HEADER = 'x-plico-client-ip'

export function clientIp(c: Context): string {
  const set = HEADER && c.req.header(HEADER)?.split(',')[0].trim()
  if (set) return set
  try { return getConnInfo(c).remote.address ?? 'unknown' } catch { return 'unknown' }
}

/** A sliding-window counter per key, in memory. Idle keys are forgotten, so a flood of new keys can't grow it forever.
 *  ponytail: per process; move to the database or Redis when the API runs as more than one process. */
export function limiter(windowMs: number, max: number) {
  const hits = new Map<string, number[]>()
  const recent = (k: string, now = Date.now()) => (hits.get(k) ?? []).filter(t => now - t < windowMs)
  setInterval(() => { const now = Date.now(); for (const [k, ts] of hits) if (now - ts[ts.length - 1] >= windowMs) hits.delete(k) }, windowMs).unref()
  return {
    /** True when this key is already at the limit (and doesn't count this try). */
    full: (k: string) => recent(k).length >= max,
    hit: (k: string) => { hits.set(k, [...recent(k), Date.now()]) },
    clear: (k: string) => { hits.delete(k) },
  }
}
