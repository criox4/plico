// Push notifications: the outbox (written with each audited change), the senders (Web Push, APNs, FCM) and the
// worker that merges, limits and delivers. What gets said, and to whom, is in push-text.ts.
import { count, gauge, traced } from './otel.ts'
import { connect } from 'node:http2'
import { sign } from 'node:crypto'
import webpush from 'web-push'
import { Prisma } from './generated/prisma/client.ts'
import { db } from './db.ts'
import { BATCHED, BATCH_MS, DAILY_CAP, URGENT, compose, local, prefFor, prefsOf, pushesFor, quietUntil, urlFor, type Change } from './push-text.ts'

type Tx = Prisma.TransactionClient
const env = process.env
const pem = (v?: string) => v?.replace(/\\n/g, '\n')

// ---------- which channels are configured ----------
const VAPID = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? { pub: env.VAPID_PUBLIC_KEY, priv: env.VAPID_PRIVATE_KEY } : null
if (VAPID) webpush.setVapidDetails('mailto:privacy@plico.space', VAPID.pub, VAPID.priv)
const APNS = env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_KEY
  ? { kid: env.APNS_KEY_ID, team: env.APNS_TEAM_ID, key: pem(env.APNS_KEY)!, host: env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com', topic: env.APNS_TOPIC || 'app.plico' }
  : null
const FCM = (() => {
  try { const sa = env.FCM_SERVICE_ACCOUNT && JSON.parse(env.FCM_SERVICE_ACCOUNT); return sa ? { email: sa.client_email as string, key: pem(sa.private_key as string)!, project: sa.project_id as string } : null } catch { console.error('FCM_SERVICE_ACCOUNT is not valid JSON'); return null }
})()
export const pushConfig = () => ({ web: VAPID?.pub ?? null, ios: !!APNS, android: !!FCM })

// ---------- the outbox ----------
/** Called from audit(), inside its transaction: one row per person who should hear about this change. */
export async function queuePush(tx: Tx, groupId: string, e: Change) {
  if (!e.kind.startsWith('expense.') && e.kind !== 'member.joined') return
  // Only people with a device to push to; everyone else has Activity.
  const people = (await tx.member.findMany({ where: { groupId }, select: { id: true, userId: true, user: { select: { pushDevices: { select: { id: true }, take: 1 } } } } }))
    .map(m => ({ id: m.id, userId: m.user?.pushDevices.length ? m.userId : null }))
  const rows = pushesFor(e, people)
  if (!rows.length) return
  // member.added goes to the joiner, who may not be listed with a device above.
  const ok = new Set((await tx.pushDevice.findMany({ where: { userId: { in: rows.map(r => r.userId) } }, select: { userId: true } })).map(d => d.userId))
  const now = Date.now()
  await tx.notification.createMany({ data: rows.filter(r => ok.has(r.userId)).map(r => ({
    userId: r.userId, kind: r.kind, data: r.data as Prisma.InputJsonValue, groupId, byId: e.byId ?? null, dueAt: new Date(BATCHED.has(r.kind) ? now + BATCH_MS : now),
  })) })
}

// ---------- senders ----------
type Msg = { title: string; body: string; url: string; tag: string }
type Result = 'ok' | 'gone' | 'error'
type Device = { id: string; platform: string; token: string; keys: Prisma.JsonValue }

async function sendWeb(d: Device, m: Msg): Promise<Result> {
  if (!VAPID) return 'error'
  try {
    await webpush.sendNotification({ endpoint: d.token, keys: d.keys as { p256dh: string; auth: string } }, JSON.stringify(m), { TTL: 86_400, urgency: 'high', topic: m.tag.replace(/[^\w-]/g, '').slice(0, 32) })
    return 'ok'
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode
    return code === 404 || code === 410 ? 'gone' : 'error'
  }
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url')
const jwt = (header: object, claims: object, key: string, ec: boolean) => {
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  return `${data}.${b64url(sign('sha256', Buffer.from(data), ec ? { key, dsaEncoding: 'ieee-p1363' } : key))}`
}

let apnsAuth = { token: '', at: 0 }
async function sendApns(d: Device, m: Msg): Promise<Result> {
  if (!APNS) return 'error'
  // Apple wants the provider token refreshed between 20 and 60 minutes.
  if (Date.now() - apnsAuth.at > 40 * 60_000) apnsAuth = { token: jwt({ alg: 'ES256', kid: APNS.kid }, { iss: APNS.team, iat: Math.floor(Date.now() / 1000) }, APNS.key, true), at: Date.now() }
  return new Promise(done => {
    const client = connect(APNS.host)
    const finish = (r: Result) => { client.close(); done(r) }
    client.on('error', () => finish('error'))
    const req = client.request({
      ':method': 'POST', ':path': `/3/device/${d.token}`, authorization: `bearer ${apnsAuth.token}`,
      'apns-topic': APNS.topic, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-collapse-id': m.tag.slice(0, 64),
    })
    let status = 0, body = ''
    req.on('response', h => { status = Number(h[':status']) })
    req.on('data', c => { body += c })
    req.on('end', () => finish(status === 200 ? 'ok' : status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body) ? 'gone' : 'error'))
    req.on('error', () => finish('error'))
    req.setTimeout(10_000, () => { req.close(); finish('error') })
    req.end(JSON.stringify({ aps: { alert: { title: m.title, body: m.body }, sound: 'default', 'thread-id': m.tag }, url: m.url }))
  })
}

let fcmAuth = { token: '', until: 0 }
async function sendFcm(d: Device, m: Msg): Promise<Result> {
  if (!FCM) return 'error'
  try {
    if (Date.now() > fcmAuth.until) {
      const now = Math.floor(Date.now() / 1000)
      const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: FCM.email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }, FCM.key, false)
      const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
      const t = await r.json() as { access_token?: string; expires_in?: number }
      if (!t.access_token) return 'error'
      fcmAuth = { token: t.access_token, until: Date.now() + ((t.expires_in ?? 3600) - 300) * 1000 }
    }
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${FCM.project}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${fcmAuth.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: d.token, notification: { title: m.title, body: m.body }, data: { url: m.url }, android: { priority: 'high', notification: { tag: m.tag } } } }),
    })
    if (r.ok) return 'ok'
    return r.status === 404 || /UNREGISTERED/.test(await r.text()) ? 'gone' : 'error'
  } catch { return 'error' }
}

const SEND: Record<string, (d: Device, m: Msg) => Promise<Result>> = { web: sendWeb, ios: sendApns, android: sendFcm }

/** Sends to every device; forgets the ones the push service says are gone. */
export async function deliver(devices: Device[], m: Msg) {
  const results = await Promise.all(devices.map(d => (SEND[d.platform] ?? (async () => 'error' as const))(d, m)))
  devices.forEach((d, i) => count.push.add(1, { channel: d.platform, result: results[i] }))
  const gone = devices.filter((_, i) => results[i] === 'gone').map(d => d.id)
  if (gone.length) await db.pushDevice.deleteMany({ where: { id: { in: gone } } })
  return results
}

// ---------- the worker ----------
type Row = { id: string; userId: string; groupId: string | null; kind: string; data: Record<string, unknown> }

/** One pass: claim what's due, merge per person and group, apply preferences, quiet hours and the daily cap, send. */
export async function flush() {
  // ponytail: a row is marked sent when claimed, so a crash mid-send drops that push rather than repeating it.
  const claimed = await db.$queryRaw<Row[]>`
    UPDATE "splittr"."notification" SET "sentAt" = now() WHERE "id" IN (
      SELECT "id" FROM "splittr"."notification" WHERE "sentAt" IS NULL AND "dueAt" <= now() ORDER BY "dueAt" LIMIT 200 FOR UPDATE SKIP LOCKED)
    RETURNING "id", "userId", "groupId", "kind", "data"`
  if (!claimed.length) return 0
  // A batch starts with its first row: pull in the rest for the same person and group, even if not yet due.
  const heads = claimed.filter(r => BATCHED.has(r.kind) && r.groupId)
  const rest = heads.length ? await db.$queryRaw<Row[]>`
    UPDATE "splittr"."notification" SET "sentAt" = now()
    WHERE "sentAt" IS NULL AND "kind" = ANY(${[...BATCHED]}) AND ("userId", "groupId") IN (SELECT * FROM unnest(${heads.map(r => r.userId)}::text[], ${heads.map(r => r.groupId!)}::text[]))
    RETURNING "id", "userId", "groupId", "kind", "data"` : []
  const rows = [...claimed, ...rest]
  const ids = rows.map(r => r.id)

  const users = await db.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.userId))] } }, select: { id: true, notify: true, tz: true, pushDevices: true } })
  const groups = new Map((await db.group.findMany({ where: { id: { in: [...new Set(rows.flatMap(r => (r.groupId ? [r.groupId] : [])))] } }, select: { id: true, name: true, kind: true } }))
    .map(g => [g.id, g.kind === 'direct' ? null : g.name]))
  const sentToday = new Map((await db.notification.groupBy({
    by: ['userId'], _count: true,
    where: { userId: { in: users.map(u => u.id) }, sentAt: { gt: new Date(Date.now() - 864e5) }, skipped: null, kind: { notIn: [...URGENT] }, id: { notIn: ids } },
  })).map(x => [x.userId, x._count]))

  const skip = new Map<string, string>(), later = new Map<string, Date>()
  let sent = 0
  for (const u of users) {
    const mine = rows.filter(r => r.userId === u.id)
    const prefs = prefsOf(u.notify)
    // Units: each group's batched rows together; everything else on its own.
    const units = new Map<string, Row[]>()
    for (const r of mine) {
      const k = BATCHED.has(r.kind) ? `b:${r.groupId}` : r.id
      units.set(k, [...(units.get(k) ?? []), r])
    }
    const wake = prefs.quiet ? quietUntil(u.tz) : null
    for (const unit of units.values()) {
      const [lead] = unit
      if (!prefs[prefFor(lead.kind)]) { unit.forEach(r => skip.set(r.id, 'off')); continue }
      if (wake) { unit.forEach(r => later.set(r.id, wake)); continue }
      if (!URGENT.has(lead.kind)) {
        const n = sentToday.get(u.id) ?? 0
        if (n >= DAILY_CAP) { unit.forEach(r => skip.set(r.id, 'cap')); continue }
        sentToday.set(u.id, n + 1)
      }
      if (!u.pushDevices.length) { unit.forEach(r => skip.set(r.id, 'nodevice')); continue }
      const group = lead.groupId ? groups.get(lead.groupId) ?? null : null
      const text = compose(unit, group, prefs.amounts)
      await deliver(u.pushDevices, { ...text, url: urlFor(lead.kind, lead.groupId), tag: lead.groupId ?? lead.kind })
      unit.slice(1).forEach(r => skip.set(r.id, 'merged'))
      sent++
    }
  }
  for (const reason of new Set(skip.values())) await db.notification.updateMany({ where: { id: { in: [...skip].filter(([, v]) => v === reason).map(([k]) => k) } }, data: { skipped: reason } })
  for (const [id, at] of later) await db.notification.update({ where: { id }, data: { sentAt: null, dueAt: at } })
  return sent
}

/** Sundays at 11:00 local: one push to everyone who has owed money for over a week, unless they got one this week. */
export async function nudge(at = new Date()) {
  return db.$transaction(async tx => {
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(7461001) AS locked`
    if (!locked) return 0 // another server is on it
    const users = await tx.user.findMany({
      where: { pushDevices: { some: {} }, notifications: { none: { kind: 'nudge', createdAt: { gt: new Date(at.getTime() - 6 * 864e5) } } } },
      select: { id: true, tz: true },
    })
    const due = users.filter(u => { const l = local(u.tz, at); return l.day === 0 && l.hour === 11 }).map(u => u.id)
    if (!due.length) return 0
    // ponytail: "owed for over a week" = owes now in a group whose oldest expense is over 7 days old. Replay balances by date if that's too loose.
    const owing = await tx.$queryRaw<{ userId: string; net: number }[]>`
      SELECT m."userId", SUM(s."paid" - s."owed")::int AS net
      FROM "splittr"."member" m
      JOIN "splittr"."expense_share" s ON s."memberId" = m."id"
      JOIN "splittr"."expense" e ON e."id" = s."expenseId"
      JOIN "splittr"."group" g ON g."id" = m."groupId"
      WHERE m."userId" = ANY(${due}) AND e."deletedAt" IS NULL AND NOT e."rejected" AND NOT g."track"
      GROUP BY m."userId", m."groupId"
      HAVING SUM(s."paid" - s."owed") < 0 AND MIN(e."createdAt") < ${new Date(at.getTime() - 7 * 864e5)}`
    const by = new Map<string, { amount: number; groups: number }>()
    for (const o of owing) { const x = by.get(o.userId) ?? { amount: 0, groups: 0 }; by.set(o.userId, { amount: x.amount - o.net, groups: x.groups + 1 }) }
    if (by.size) await tx.notification.createMany({ data: [...by].map(([userId, d]) => ({ userId, kind: 'nudge', data: d })) })
    return by.size
  })
}

/** Runs the worker in this process: sends every 15 s, checks for the weekly nudge every 5 min, prunes old rows hourly. */
export function startPush() {
  if (env.PUSH_WORKER === 'off') return
  let busy = false, lastNudge = 0, lastPrune = 0
  gauge.pushPending.addCallback(async r => r.observe(await db.notification.count({ where: { sentAt: null, dueAt: { lte: new Date() } } })))
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      await traced('push.flush', flush)
      if (Date.now() - lastNudge > 5 * 60_000) { lastNudge = Date.now(); await nudge() }
      if (Date.now() - lastPrune > 3600_000) { lastPrune = Date.now(); await db.notification.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * 864e5) }, sentAt: { not: null } } }) }
    } catch (e) { console.error('push worker', e) } finally { busy = false }
  }
  setInterval(tick, 15_000).unref()
}
