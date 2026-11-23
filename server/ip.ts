// Who's calling, for rate limits. Clients can send any header they like, so only two sources are trusted: the header
// our own proxy sets (CLIENT_IP_HEADER, e.g. fly-client-ip, cf-connecting-ip, or x-real-ip from nginx), or else the
// TCP connection's address. Never x-forwarded-for as sent: its leftmost value is whatever the client wrote.
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { db } from './db.ts'

const HEADER = process.env.CLIENT_IP_HEADER?.trim().toLowerCase()
/** Better Auth reads the client IP from this header, which we set on every request after dropping any sent value. */
export const IP_HEADER = 'x-plico-client-ip'

export function clientIp(c: Context): string {
  const set = HEADER && c.req.header(HEADER)?.split(',')[0].trim()
  if (set) return set
  try { return getConnInfo(c).remote.address ?? 'unknown' } catch { return 'unknown' }
}

/** A sliding-window counter per key, kept in the database (rate_hit): it survives a deploy and holds across processes.
 *  Windows are a day at most; older rows are pruned now and then.
 *  ponytail: count, then record, not one atomic step: a burst of parallel requests can slip a few past the limit. */
export function limiter(name: string, windowMs: number, max: number) {
  const key = (k: string) => `${name}:${k}`.slice(0, 300)
  const count = (k: string, ms = windowMs) => db.rateHit.count({ where: { key: key(k), at: { gt: new Date(Date.now() - ms) } } })
  return {
    /** How many tries this key has made in the last `ms` (default: the window). */
    count,
    /** True when this key is already at the limit (and doesn't count this try). */
    full: async (k: string) => (await count(k)) >= max,
    hit: async (k: string) => {
      await db.rateHit.create({ data: { key: key(k) } })
      if (Math.random() < 0.01) void db.rateHit.deleteMany({ where: { at: { lt: new Date(Date.now() - 864e5) } } }).catch(() => {})
    },
    clear: async (k: string) => { await db.rateHit.deleteMany({ where: { key: key(k) } }) },
    /** Counts this try unless the key is already at the limit: true when it was refused. */
    over: async (k: string) => { if ((await count(k)) >= max) return true; await db.rateHit.create({ data: { key: key(k) } }); return false },
  }
}
