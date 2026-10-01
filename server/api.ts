import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { bodyLimit } from 'hono/body-limit'
import * as z from 'zod/mini'
import { AgeIn, AiConsentIn, ChatIn, ExpenseIn, FileName, FriendCode, FriendIn, GroupIn, GuardianIn, Id, InviteCode, InviteResendIn, MemberIn, NotifyIn, ParentConsentIn, PushDeviceIn, PushTokenIn, ReadIn, RemindIn, SeenIn, Token } from '../src/schema.ts'
import { auth } from './auth.ts'
import { db } from './db.ts'
import { mail } from './email.ts'
import { aiReady, readExpense } from './ai.ts'
import { BUCKET, deleteFile, getFile, imageType, putFile, storageReady } from './storage.ts'
import { Prisma } from './generated/prisma/client.ts'
import { audit, changed } from './audit.ts'
import { prefsOf } from './push-text.ts'
import { chat } from './chat.ts'
import { mePhone } from './whatsapp.ts'
import { clientIp, limiter } from './ip.ts'
import { count } from './otel.ts'
import { createHash, randomInt } from 'node:crypto'
import { isVpa, sharesError } from '../src/logic.ts'
import { THEMES } from '../src/themes.ts'

type Env = { Variables: { userId: string; userName: string; sessionId: string } }
// Public (no sign-in): a parent opening the consent link from their email.
export const publicApi = new Hono()
const guardianToken = async (token: string) => {
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const v = await db.verification.findFirst({ where: { value: token, identifier: { startsWith: 'guardian:' }, expiresAt: { gt: new Date() } } })
  if (!v) return null
  const user = await db.user.findUnique({ where: { id: v.identifier.slice(9) }, select: { id: true, name: true, email: true, guardianConsentAt: true } })
  return user && !user.guardianConsentAt ? { v, user } : null
}
publicApi.get('/guardian/:token', async c => {
  const t = await guardianToken(c.req.param('token'))
  return t ? c.json({ child: { name: t.user.name, email: t.user.email } }) : c.json({ error: 'This link has expired or was already used' }, 404)
})
publicApi.post('/guardian/:token', async c => {
  const b = ParentConsentIn.parse(await c.req.json())
  const t = await guardianToken(c.req.param('token'))
  if (!t) return c.json({ error: 'This link has expired or was already used' }, 404)
  await db.verification.delete({ where: { id: t.v.id } })
  if (!b.consent) {
    // Without consent we can't keep a minor's data: the account goes (shared groups keep them as a guest).
    await db.user.delete({ where: { id: t.user.id } })
    return c.json({ ok: true, deleted: true })
  }
  if (!b.name || !b.adult) return c.json({ error: 'Add your name and confirm you’re their parent or guardian, 18 or older' }, 400)
  await db.user.update({ where: { id: t.user.id }, data: { guardianConsentAt: new Date(), guardianName: b.name } })
  return c.json({ ok: true })
})

// Invite previews: what a link shows before anyone signs up. Just enough to decide (the group, who invited you),
// never member names, emails or amounts, so a forwarded link doesn't leak the group.
const peeks = limiter(60_000, 30)
const peekLimit = (c: Context) => { const ip = clientIp(c); if (peeks.full(ip)) return true; peeks.hit(ip); return false }
const inviterOf = async (groupId: string, memberId?: string) => {
  const e = await db.auditEvent.findFirst({ where: { groupId, ...(memberId ? { memberId, kind: 'member.invited' } : { kind: 'group.created' }) }, orderBy: { seq: 'asc' }, select: { byName: true } })
  return e?.byName ?? 'A friend'
}
publicApi.get('/public/invites/:code', async c => {
  if (peekLimit(c)) return c.json({ error: 'Too many tries. Wait a minute.' }, 429)
  const g = await db.group.findUnique({ where: { inviteCode: InviteCode.parse(c.req.param('code')) }, select: { id: true, name: true, kind: true, theme: true, _count: { select: { members: true } } } })
  if (!g || g.kind === 'direct') return c.json({ error: 'This invite link is no longer valid' }, 404)
  return c.json({ group: { name: g.name, kind: g.kind, theme: g.theme, people: g._count.members }, invitedBy: await inviterOf(g.id) })
})
publicApi.get('/public/claim/:token', async c => {
  if (peekLimit(c)) return c.json({ error: 'Too many tries. Wait a minute.' }, 429)
  const token = c.req.param('token')
  if (!/^[a-f0-9]{32}$/.test(token)) return c.json({ error: 'This invite was already used or is no longer valid' }, 404)
  const m = await db.member.findUnique({ where: { inviteToken: token }, select: { id: true, name: true, email: true, userId: true, group: { select: { id: true, name: true, kind: true, theme: true } } } })
  if (!m || m.userId) return c.json({ error: 'This invite was already used or is no longer valid' }, 404)
  // The token was emailed to this address, so whoever holds it can see it: it pre-fills their sign-up.
  const mask = m.email ? m.email.replace(/^(.{1,2})[^@]*/, '$1***') : null
  return c.json({ group: { name: m.group.name, kind: m.group.kind, theme: m.group.theme }, invitedBy: await inviterOf(m.group.id, m.id), name: m.name, email: mask, prefill: m.email })
})
// A personal friend link: who you'd be adding, a name and a face, nothing else.
publicApi.get('/public/u/:code', async c => {
  if (peekLimit(c)) return c.json({ error: 'Too many tries. Wait a minute.' }, 429)
  const code = FriendCode.safeParse(c.req.param('code'))
  const u = code.success ? await db.user.findUnique({ where: { friendCode: code.data }, select: { name: true, image: true } }) : null
  return u ? c.json(u) : c.json({ error: 'This link is no longer valid' }, 404)
})

export const api = new Hono<Env>()

const APP = process.env.PUBLIC_URL || 'http://localhost:5173'
const claimUrl = (token: string) => `${APP}/#/claim/${token}`

const inviteCode = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const notFound = { error: 'Not found' }

api.use('*', async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!s) return c.json({ error: 'Sign in first' }, 401)
  c.set('userId', s.user.id)
  c.set('userName', s.user.name)
  c.set('sessionId', s.session.id)
  // Age gate (DPDP Act s.9): nobody uses Plico before saying how old they are, and 13-17 year olds wait for a parent.
  const u = s.user as typeof s.user & { ageGroup?: string | null; guardianConsentAt?: Date | null }
  const open = /^\/api\/me\/(age|guardian|export)$/.test(c.req.path)
  if (!open && !u.ageGroup) return c.json({ error: 'Tell us your age first', code: 'age' }, 403)
  if (!open && u.ageGroup === 'teen' && !u.guardianConsentAt) return c.json({ error: 'Waiting for a parent’s consent', code: 'guardian' }, 403)
  await next()
})

api.route('/me/phone', mePhone) // verifying a phone number over WhatsApp (server/whatsapp.ts)

// ---------- age, parental consent, AI consent, data export ----------
async function askGuardian(uid: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: uid }, select: { name: true, email: true, guardianEmail: true } })
  if (!u.guardianEmail) return
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  await db.verification.deleteMany({ where: { identifier: `guardian:${uid}` } })
  await db.verification.create({ data: { id: crypto.randomUUID(), identifier: `guardian:${uid}`, value: token, expiresAt: new Date(Date.now() + 14 * 864e5) } })
  void mail.guardian(u.guardianEmail, u.name, u.email, `${APP}/#/guardian/${token}`).catch(console.error)
}

api.post('/me/age', async c => {
  const b = AgeIn.parse(await c.req.json())
  const uid = c.get('userId')
  const u = await db.user.findUniqueOrThrow({ where: { id: uid }, select: { ageGroup: true, email: true } })
  if (u.ageGroup && u.ageGroup !== b.group) return c.json({ error: 'Your age is already set. If it’s wrong, write to privacy@plico.space.' }, 409)
  if (b.group === 'teen' && !b.guardianEmail) return c.json({ error: 'Enter your parent’s email' }, 400)
  if (b.group === 'teen' && b.guardianEmail === u.email.toLowerCase()) return c.json({ error: 'That’s your own email. We need your parent’s.' }, 400)
  await db.user.update({ where: { id: uid }, data: { ageGroup: b.group, guardianEmail: b.group === 'teen' ? b.guardianEmail : null } })
  if (b.group === 'teen') await askGuardian(uid)
  return c.json({ ok: true })
})

// A teen can change the parent's email or resend the request (once a minute).
api.post('/me/guardian', async c => {
  const b = GuardianIn.parse(await c.req.json().catch(() => ({})))
  const uid = c.get('userId')
  const u = await db.user.findUniqueOrThrow({ where: { id: uid }, select: { ageGroup: true, guardianConsentAt: true, email: true } })
  if (u.ageGroup !== 'teen' || u.guardianConsentAt) return c.json({ error: 'No consent needed' }, 409)
  const last = await db.verification.findFirst({ where: { identifier: `guardian:${uid}` }, select: { createdAt: true } })
  if (last && Date.now() - last.createdAt.getTime() < 60_000) return c.json({ error: 'Just sent. Try again in a minute.' }, 429)
  if (b.email) {
    if (b.email === u.email.toLowerCase()) return c.json({ error: 'That’s your own email. We need your parent’s.' }, 400)
    await db.user.update({ where: { id: uid }, data: { guardianEmail: b.email } })
  }
  await askGuardian(uid)
  return c.json({ ok: true })
})

/** The first-run profile is done (name, face, UPI IDs); the app stops showing it. */
api.post('/me/onboarded', async c => {
  await db.user.update({ where: { id: c.get('userId') }, data: { onboardedAt: new Date() } })
  return c.json({ ok: true })
})

api.post('/me/ai', async c => {
  const { consent } = AiConsentIn.parse(await c.req.json())
  await db.user.update({ where: { id: c.get('userId') }, data: { aiOffAt: consent ? null : new Date() } })
  return c.json({ ok: true })
})

// Everything we hold about you, as JSON (DPDP access right, GDPR access + portability).
api.get('/me/export', async c => {
  const uid = c.get('userId')
  const user = await db.user.findUniqueOrThrow({ where: { id: uid } })
  const sessions = await db.session.findMany({ where: { userId: uid }, select: { createdAt: true, expiresAt: true, ipAddress: true, userAgent: true } })
  const accounts = await db.account.findMany({ where: { userId: uid }, select: { providerId: true, createdAt: true } })
  const groups = await db.group.findMany({
    where: { members: { some: { userId: uid } } },
    select: { id: true, name: true, kind: true, theme: true, emoji: true, createdAt: true,
      members: { select: { id: true, name: true, upi: true, upi2: true, email: true, phone: true, userId: true } },
      expenses: { select: { id: true, title: true, cat: true, date: true, amount: true, settle: true, pending: true, rejected: true, verifiedBy: true, proof: true, receipt: true, createdAt: true, version: true, deletedAt: true, shares: { select: { memberId: true, paid: true, owed: true } } } } },
  })
  const history = await db.auditEvent.findMany({ where: { byId: uid }, orderBy: { at: 'asc' }, select: { groupId: true, seq: true, kind: true, expenseId: true, memberId: true, at: true, before: true, after: true, effect: true } })
  const data = { exportedAt: new Date(), note: 'Amounts are in paise (₹1 = 100 paise). Photos are listed by file name; download them from the app. "history" lists the changes you made.', user, signIns: accounts, sessions, groups, history }
  return c.body(JSON.stringify(data, null, 2), 200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="plico-export.json"' })
})

api.onError((e, c) => {
  if (e instanceof z.core.$ZodError) return c.json({ error: e.issues[0]?.message ?? 'Invalid input' }, 400)
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return c.json({ error: 'Already exists' }, 409)
  console.error(e)
  return c.json({ error: 'Something went wrong' }, 500)
})

/** The caller's membership in a group, or null. Every group route goes through this. */
const membership = (groupId: string, userId: string) => db.member.findFirst({ where: { groupId, userId } })

// ---------- expenses: versions, soft deletes, history ----------
const withShares = { shares: { select: { memberId: true, paid: true, owed: true } } } as const
type Stored = Prisma.ExpenseGetPayload<{ include: typeof withShares }>
const sortKeys = (o: unknown) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))) : o ?? null)
/** An expense as history and conflict checks see it (key order normalised: jsonb reorders keys). */
const snapOf = (e: Omit<Stored, 'id' | 'groupId' | 'createdById' | 'createdAt' | 'updatedAt' | 'version' | 'deletedAt' | 'updatedById' | 'verifiedBy' | 'verifiedAt' | 'proof' | 'utr'> & { verifiedBy?: string | null }) => ({
  title: e.title, cat: e.cat, date: e.date, amount: e.amount, mode: e.mode, input: sortKeys(e.input), settle: e.settle, pending: e.pending, rejected: e.rejected,
  ...(e.verifiedBy && { verifiedBy: e.verifiedBy }), // only when set, so entries from before verification look as they did
  receipt: e.receipt, repeatNext: e.repeatNext, repeatDay: e.repeatDay,
  shares: [...e.shares].filter(x => x.paid || x.owed).sort((a, b) => a.memberId.localeCompare(b.memberId)).map(x => ({ memberId: x.memberId, paid: x.paid, owed: x.owed })),
})
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
class Stale extends Error {}

/** 409: someone changed (or deleted) it after the version this edit started from. Carries their version and who made it. */
async function conflict(c: { json: (b: unknown, s: 409) => Response }, eid: string) {
  const [theirs, last] = await Promise.all([
    db.expense.findUnique({ where: { id: eid }, include: withShares }),
    db.auditEvent.findFirst({ where: { expenseId: eid }, orderBy: { seq: 'desc' }, select: { byName: true, at: true, kind: true } }),
  ])
  return c.json({ error: 'Someone else changed this first', code: 'conflict', theirs, by: last?.byName ?? 'Someone', at: last?.at ?? theirs?.updatedAt, action: last?.kind.split('.')[1] }, 409)
}

// Groups for this user. `since` + `known` (group ids this phone already has) = only what changed, including deletions;
// groups it doesn't know yet come in full. No `since` = everything (first launch, new device).
api.get('/groups', async c => {
  const uid = c.get('userId')
  // ponytail: 10s overlap covers transactions that commit after we read; re-sending a few rows is harmless (merges are idempotent).
  const now = new Date(Date.now() - 10_000)
  const sinceQ = c.req.query('since'), since = sinceQ ? new Date(sinceQ) : null
  const known = new Set((c.req.query('known') ?? '').split(',').filter(Boolean))
  const groups = await db.group.findMany({
    where: { members: { some: { userId: uid } } },
    include: { members: { orderBy: { createdAt: 'asc' }, omit: { inviteToken: true }, include: { user: { select: { image: true, email: true } } } } },
    orderBy: { createdAt: 'desc' },
  })
  const delta = since && !isNaN(+since) ? groups.filter(g => known.has(g.id)).map(g => g.id) : []
  const full = groups.map(g => g.id).filter(id => !delta.includes(id))
  const expenses = await db.expense.findMany({
    where: { OR: [{ groupId: { in: full }, deletedAt: null }, ...(delta.length ? [{ groupId: { in: delta }, updatedAt: { gt: since! } }] : [])] },
    include: withShares, orderBy: { createdAt: 'asc' },
  })
  const byGroup = new Map<string, typeof expenses>()
  for (const e of expenses) (byGroup.get(e.groupId) ?? byGroup.set(e.groupId, []).get(e.groupId)!).push(e)
  return c.json({ now, groups: groups.map(g => ({ ...g, full: !delta.includes(g.id), expenses: byGroup.get(g.id) ?? [] })) })
})

// A group's whole audit log, oldest first, so the phone can check the hash chain end to end and export it.
// ponytail: one response per group; page it (with a verified checkpoint) when logs reach many thousands of entries.
api.get('/groups/:gid/audit', async c => {
  const gid = Id.parse(c.req.param('gid'))
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  const [events, head] = await Promise.all([
    db.auditEvent.findMany({ where: { groupId: gid }, orderBy: { seq: 'asc' }, omit: { id: true } }),
    db.group.findUniqueOrThrow({ where: { id: gid }, select: { auditSeq: true, auditHash: true } }),
  ])
  return c.json({ head, events })
})

// Every version of one expense, oldest first.
api.get('/groups/:gid/expenses/:eid/history', async c => {
  const [gid, eid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('eid'))]
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  return c.json(await db.auditEvent.findMany({ where: { groupId: gid, expenseId: eid }, orderBy: { seq: 'asc' } }))
})

// Activity: everything that happened in my groups (scope=all) or only what moved my balance (scope=money),
// newest first, 50 a page, with how many entries by other people I haven't seen yet.
api.get('/me/activity', async c => {
  const uid = c.get('userId')
  const money = c.req.query('scope') === 'money', ai = c.req.query('scope') === 'ai'
  const [mine, me] = await Promise.all([
    db.member.findMany({ where: { userId: uid }, select: { id: true, groupId: true, group: { select: { name: true, kind: true } } } }),
    db.user.findUniqueOrThrow({ where: { id: uid }, select: { activitySeenAt: true } }),
  ])
  const byGroup = new Map(mine.map(m => [m.groupId, m]))
  const unread = () => db.auditEvent.count({ where: { groupId: { in: [...byGroup.keys()] }, byId: { not: uid }, ...(me.activitySeenAt && { at: { gt: me.activitySeenAt } }) } })
  if (c.req.query('peek')) return c.json({ unread: await unread() }) // just the badge, on every sync
  const before = c.req.query('before')
  const where = { groupId: { in: [...byGroup.keys()] }, ...(money && { kind: { startsWith: 'expense.' } }), ...(ai && { via: 'ai' }), ...(before && !isNaN(Date.parse(before)) && { at: { lt: new Date(before) } }) }
  // ponytail: "money" filters after the query (the member id differs per group); fine at hundreds of entries a page.
  const rows = await db.auditEvent.findMany({ where, orderBy: { at: 'desc' }, take: money ? 200 : 50 })
  const events = rows
    .map(e => ({ ...e, group: byGroup.get(e.groupId)!.group, memberOf: byGroup.get(e.groupId)!.id, byMe: e.byId === uid, myEffect: (e.effect as Record<string, number>)[byGroup.get(e.groupId)!.id] ?? 0 }))
    .filter(e => !money || e.myEffect).slice(0, 50)
  return c.json({ events, unread: await unread(), next: rows.length === (money ? 200 : 50) ? rows.at(-1)!.at : null })
})

// Seen up to here: clears the Activity badge on every device. Never moves backwards, never past now.
api.post('/me/activity/seen', async c => {
  const { at } = SeenIn.parse(await c.req.json())
  const when = new Date(Math.min(Date.parse(at), Date.now()))
  await db.user.updateMany({ where: { id: c.get('userId'), OR: [{ activitySeenAt: null }, { activitySeenAt: { lt: when } }] }, data: { activitySeenAt: when } })
  return c.json({ ok: true })
})

// My money log: entries across all my groups that moved my balance, newest first (paged by `before`, an ISO time).
api.get('/me/audit', async c => {
  const uid = c.get('userId')
  const mine = await db.member.findMany({ where: { userId: uid }, select: { id: true, groupId: true, group: { select: { name: true, kind: true } } } })
  const me = new Map(mine.map(m => [m.groupId, m]))
  const before = c.req.query('before')
  const rows = await db.auditEvent.findMany({
    where: { groupId: { in: [...me.keys()] }, kind: { startsWith: 'expense.' }, ...(before && !isNaN(Date.parse(before)) && { at: { lt: new Date(before) } }) },
    orderBy: { at: 'desc' }, take: 300,
  })
  const events = rows.filter(e => (e.effect as Record<string, number>)[me.get(e.groupId)!.id])
    .map(e => ({ ...e, memberOf: me.get(e.groupId)!.id, group: me.get(e.groupId)!.group }))
  return c.json({ events, more: rows.length === 300, last: rows.at(-1)?.at ?? null })
})

api.put('/groups/:id', async c => {
  const id = Id.parse(c.req.param('id'))
  const b = GroupIn.parse(await c.req.json())
  const uid = c.get('userId')
  const by = { byId: uid, byName: c.get('userName') }
  const cur = await db.group.findUnique({ where: { id } })
  if (cur) {
    if (!(await membership(id, uid))) return c.json(notFound, 404)
    // A friends (direct) group keeps its kind and has no name of its own; the rest any member may change, on the record.
    const next = cur.kind === 'direct' ? { theme: b.theme, emoji: b.emoji ?? null, cover: b.cover ?? null }
      : { name: b.name, kind: b.kind === 'direct' ? cur.kind : b.kind, theme: b.theme, track: !!b.track, emoji: b.emoji ?? null, cover: b.cover ?? null }
    const diff = changed(cur as unknown as Record<string, unknown>, next)
    if (diff) await db.$transaction(async tx => {
      await tx.group.update({ where: { id }, data: next })
      await audit(tx, id, { kind: 'group.edited', ...by, ...diff })
    })
  } else {
    if (b.kind === 'direct') return c.json({ error: 'Add friends from the Friends tab' }, 400)
    await db.$transaction(async tx => {
      await tx.group.create({
        data: { id, name: b.name, kind: b.kind, theme: b.theme, track: !!b.track, emoji: b.emoji ?? null, cover: b.cover ?? null, inviteCode: inviteCode(), createdById: uid,
          members: { create: { id: b.selfId, name: c.get('userName'), userId: uid } } },
      })
      await audit(tx, id, { kind: 'group.created', memberId: b.selfId, ...by, after: { name: b.name, kind: b.kind, theme: b.theme } })
    })
  }
  return c.json({ ok: true })
})

api.delete('/groups/:id', async c => {
  const g = await db.group.findUnique({ where: { id: Id.parse(c.req.param('id')) } })
  if (!g) return c.json({ ok: true }) // idempotent: already gone
  if (g.kind === 'direct') return c.json({ error: 'Friends can’t be deleted' }, 403)
  if (g.createdById !== c.get('userId')) return c.json({ error: 'Only the person who made the group can delete it' }, 403)
  await db.group.delete({ where: { id: g.id } })
  return c.json({ ok: true })
})

// Leave a group you're settled in. Your spot goes back to being your email, so the history and everyone's totals stay
// exactly as they were; if you made the group, the longest-standing member on Plico takes it over.
api.post('/groups/:gid/leave', async c => {
  const gid = Id.parse(c.req.param('gid'))
  const uid = c.get('userId')
  const me = await membership(gid, uid)
  if (!me) return c.json({ ok: true })
  const g = await db.group.findUniqueOrThrow({ where: { id: gid }, include: { members: { where: { userId: { not: null } }, orderBy: { createdAt: 'asc' } } } })
  if (g.kind === 'direct') return c.json({ error: 'A balance with a friend can’t be left' }, 400)
  const shares = await db.expenseShare.findMany({ where: { memberId: me.id, expense: { deletedAt: null, rejected: false } }, select: { paid: true, owed: true } })
  const balance = shares.reduce((a, s) => a + s.paid - s.owed, 0)
  if (balance) return c.json({ error: balance > 0 ? 'People still owe you here. Settle up first.' : 'You still owe money here. Settle up first.', balance }, 409)
  const heir = g.members.find(m => m.userId !== uid)
  if (g.createdById === uid && !heir) return c.json({ error: 'You’re the only one on Plico here. Delete the group instead.' }, 409)
  const user = await db.user.findUniqueOrThrow({ where: { id: uid }, select: { email: true } })
  await db.$transaction(async tx => {
    await tx.member.update({ where: { id: me.id }, data: { userId: null, email: user.email.toLowerCase(), inviteToken: null, invitedAt: null } })
    if (g.createdById === uid) await tx.group.update({ where: { id: gid }, data: { createdById: heir!.userId } })
    await audit(tx, gid, { kind: 'member.left', memberId: me.id, byId: uid, byName: c.get('userName'), before: { name: me.name, email: user.email.toLowerCase() } })
  })
  return c.json({ ok: true })
})

api.get('/groups/:id/invite', async c => {
  const id = Id.parse(c.req.param('id'))
  if (!(await membership(id, c.get('userId')))) return c.json(notFound, 404)
  const g = await db.group.findUniqueOrThrow({ where: { id }, select: { inviteCode: true } })
  return c.json({ code: g.inviteCode })
})

// A leaked link lets anyone join: any member can retire it. The old link stops working at once.
api.post('/groups/:id/invite/reset', async c => {
  const id = Id.parse(c.req.param('id'))
  if (!(await membership(id, c.get('userId')))) return c.json(notFound, 404)
  const g = await db.group.update({ where: { id }, data: { inviteCode: inviteCode() }, select: { inviteCode: true } })
  return c.json({ code: g.inviteCode })
})

api.put('/groups/:gid/members/:mid', async c => {
  const [gid, mid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('mid'))]
  const b = MemberIn.parse(await c.req.json())
  const uid = c.get('userId'), by = { byId: uid, byName: c.get('userName') }
  if (!(await membership(gid, uid))) return c.json(notFound, 404)
  const m = await db.member.findUnique({ where: { id: mid } })
  if (m && m.groupId !== gid) return c.json(notFound, 404)
  // Someone with an account owns their details. Letting others edit a joined person's UPI ID would let them
  // redirect that person's incoming payments, so those edits are ignored (not errors: they may be stale outbox ops).
  if (m?.userId && m.userId !== uid) return c.json({ ok: true, ignored: true })
  const email = b.email?.toLowerCase() || null, phone = b.phone || null
  const data = { name: b.name, upi: b.upi || null, upi2: b.upi2 || null, email: m?.userId ? m.email : email, phone }
  // Everyone in a group is a real person: an account, or an email or phone number that becomes one when they join.
  if (!m?.userId && !email && !phone) return c.json({ error: 'Add their phone number or email so they can join.' }, 400)
  if (!m) {
    const g = await db.group.findUniqueOrThrow({ where: { id: gid }, select: { kind: true } })
    if (g.kind === 'direct') return c.json({ error: 'A friends balance is just the two of you. Make a group to add more people.' }, 400)
  }
  if (email && email !== m?.email) {
    const dup = await db.member.findFirst({ where: { groupId: gid, id: { not: mid }, OR: [{ email: { equals: email, mode: 'insensitive' } }, { user: { email: { equals: email, mode: 'insensitive' } } }] } })
    if (dup) return c.json({ error: `${dup.name} is already in this group with that email.` }, 409)
  }
  if (phone && phone !== m?.phone) {
    const dup = await db.member.findFirst({ where: { groupId: gid, id: { not: mid }, OR: [{ phone }, { user: { verifiedPhone: phone } }] } })
    if (dup) return c.json({ error: `${dup.name} is already in this group with that number.` }, 409)
  }
  // Until someone joins, their UPI IDs, phone and email belong to whoever added them. Anyone else changing them could send
  // everyone's "Pay Riya" to their own UPI ID, or move Riya's invite (and spot: a verified phone claims it) to one they control.
  if (m && !m.userId && m.addedById && m.addedById !== uid && (data.upi !== m.upi || data.upi2 !== m.upi2 || data.email !== m.email || data.phone !== m.phone)) {
    const adder = await db.member.findFirst({ where: { groupId: gid, userId: m.addedById }, select: { name: true } })
    if (adder) return c.json({ error: `Only ${adder.name}, who added ${m.name}, can change their UPI ID, phone or email.`, code: 'not-yours' }, 403)
  }
  if (!m) {
    await db.$transaction(async tx => {
      await tx.member.create({ data: { id: mid, groupId: gid, addedById: uid, ...data } })
      await audit(tx, gid, { kind: 'member.invited', memberId: mid, ...by, after: { name: data.name, email, ...(phone && { phone }) } })
    })
  } else {
    const diff = changed({ name: m.name, upi: m.upi, upi2: m.upi2, email: m.email, phone: m.phone }, data)
    if (!diff) return c.json({ ok: true })
    // A corrected email or phone retires the old personal link: it may have gone to the wrong person.
    const retire = !m.userId && (email !== m.email || phone !== m.phone) ? { inviteToken: null, invitedAt: null } : {}
    await db.$transaction(async tx => {
      await tx.member.update({ where: { id: mid }, data: { ...data, ...retire } })
      await audit(tx, gid, { kind: 'member.edited', memberId: mid, ...by, ...diff })
    })
  }
  // A new email: link now if that person already has a verified account, otherwise email an invite.
  if (email && email !== m?.email && !m?.userId && !(await inviteByEmail(gid, mid, email, { id: uid, name: c.get('userName') }))) return c.json({ ok: true, emailed: false })
  return c.json({ ok: true })
})

/** Invite emails carry names the sender typed, to any address: capped so Plico can't be used to spam or phish.
 *  Past a cap the person is still added; the inviter shares the link themselves. */
const INVITES_A_DAY = 20, TO_ONE_ADDRESS_A_DAY = 3
async function mayEmail(byId: string, to: string) {
  const since = new Date(Date.now() - 864e5)
  const [sent, received] = await Promise.all([
    db.emailLog.count({ where: { byId, at: { gt: since } } }),
    db.emailLog.count({ where: { to, at: { gt: since } } }),
  ])
  if (sent >= INVITES_A_DAY || received >= TO_ONE_ADDRESS_A_DAY) return false
  await db.emailLog.create({ data: { byId, to } })
  if (Math.random() < 0.01) void db.emailLog.deleteMany({ where: { at: { lt: new Date(Date.now() - 2 * 864e5) } } }).catch(() => {})
  return true
}

/** Links the spot if that email already has an account, otherwise emails an invite. False when a cap stopped the email. */
async function inviteByEmail(gid: string, mid: string, email: string, by: { id: string; name: string }) {
  const inviter = by.name
  const g = await db.group.findUniqueOrThrow({ where: { id: gid }, select: { name: true } })
  const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, emailVerified: true } })
  if (user) {
    const count = await db.$transaction(async tx => {
      const { count } = await tx.member.updateMany({ where: { id: mid, userId: null, group: { members: { none: { userId: user.id } } } }, data: { userId: user.id, inviteToken: null, name: user.name } })
      if (count) await audit(tx, gid, { kind: 'member.joined', memberId: mid, byId: user.id, byName: user.name, after: { email, how: 'email', addedBy: inviter } })
      return count
    })
    if (count && await mayEmail(by.id, user.email.toLowerCase())) void mail.added(user.email, inviter, g.name).catch(console.error)
    return true
  }
  const token = await ensureToken(mid)
  if (!(await mayEmail(by.id, email))) return false
  await db.member.update({ where: { id: mid }, data: { invitedAt: new Date() } })
  void mail.invite(email, inviter, g.name, claimUrl(token)).catch(console.error)
  return true
}
const capped = 'You’ve sent a lot of invite emails today. Share their invite link on WhatsApp instead.'

async function ensureToken(mid: string) {
  const m = await db.member.findUniqueOrThrow({ where: { id: mid }, select: { inviteToken: true } })
  if (m.inviteToken) return m.inviteToken
  const token = crypto.randomUUID().replace(/-/g, '')
  await db.member.update({ where: { id: mid }, data: { inviteToken: token } })
  return token
}

// Invite link for one person (WhatsApp for phones), and a throttled email resend.
api.post('/groups/:gid/members/:mid/invite', async c => {
  const [gid, mid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('mid'))]
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  const m = await db.member.findUnique({ where: { id: mid } })
  if (!m || m.groupId !== gid) return c.json(notFound, 404)
  if (m.userId) return c.json({ error: 'Already joined' }, 409)
  const { email } = InviteResendIn.parse(await c.req.json().catch(() => ({})))
  if (email && m.email) {
    if (m.invitedAt && Date.now() - m.invitedAt.getTime() < 60_000) return c.json({ error: 'Invite just sent. Try again in a minute.' }, 429)
    if (!(await inviteByEmail(gid, mid, m.email, { id: c.get('userId'), name: c.get('userName') }))) return c.json({ error: capped, link: claimUrl(await ensureToken(mid)) }, 429)
  }
  return c.json({ link: claimUrl(await ensureToken(mid)) })
})

api.delete('/groups/:gid/members/:mid', async c => {
  const [gid, mid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('mid'))]
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  const m = await db.member.findUnique({ where: { id: mid }, include: { _count: { select: { shares: true } } } })
  if (!m || m.groupId !== gid) return c.json({ ok: true })
  if (m.userId || m._count.shares) return c.json({ error: 'People with expenses or an account can’t be removed' }, 409)
  await db.$transaction(async tx => {
    await tx.member.delete({ where: { id: mid } })
    await audit(tx, gid, { kind: 'member.removed', memberId: mid, byId: c.get('userId'), byName: c.get('userName'), before: { name: m.name, email: m.email } })
  })
  return c.json({ ok: true })
})

api.put('/groups/:gid/expenses/:eid', async c => {
  const [gid, eid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('eid'))]
  const b = ExpenseIn.parse(await c.req.json())
  const uid = c.get('userId')
  const me = await membership(gid, uid)
  if (!me) return c.json(notFound, 404)
  const all = await db.member.findMany({ where: { groupId: gid }, select: { id: true, name: true, userId: true, user: { select: { email: true } } } })
  const bad = sharesError(b.amount, b.paid, b.owed, new Set(all.map(m => m.id)))
  if (bad) return c.json({ error: bad }, 400)
  const existing = await db.expense.findUnique({ where: { id: eid }, include: withShares })
  if (existing && existing.groupId !== gid) return c.json(notFound, 404)

  // A settlement counts as soon as it's recorded; `pending` only means not verified yet. Only the payee can verify it
  // (or nobody can, when the payee is a guest: then it's verified at once). Anyone else's record waits for them; a
  // verified one stays verified while its amount is unchanged.
  const payee = b.settle ? all.find(m => m.id === Object.keys(b.owed)[0]) : undefined
  const canConfirm = !payee?.userId || payee.userId === uid
  const pending = !!b.settle && (canConfirm ? !!b.pending : !(existing && !existing.pending && existing.amount === b.amount))
  // Only the payee can say it hasn't arrived: the one thing that stops a settlement counting.
  const rejected = !!b.settle && (payee?.userId === uid ? !!b.rejected : !!existing?.rejected)
  // Verified by the payee, unless it already was (by them or by the payer's receipt) at this amount.
  const kept = existing?.verifiedBy && !existing.pending && !existing.rejected && existing.amount === b.amount
  const verifiedBy = b.settle && !pending && !rejected ? (kept ? existing.verifiedBy : 'payee') : null
  const verifiedAt = verifiedBy ? (kept ? existing.verifiedAt : new Date()) : null

  const ids = new Set([...Object.keys(b.paid), ...Object.keys(b.owed)])
  const shares = [...ids].map(memberId => ({ memberId, paid: b.paid[memberId] ?? 0, owed: b.owed[memberId] ?? 0 }))
  const data = {
    title: b.title, cat: b.cat, date: b.date, amount: b.amount, mode: b.mode ?? null, input: b.input ?? Prisma.DbNull,
    settle: !!b.settle, pending: pending && !rejected, rejected, verifiedBy, verifiedAt, receipt: b.receipt ?? null, repeatNext: b.repeat?.next ?? null, repeatDay: b.repeat?.day ?? null,
  }
  const after = snapOf({ ...data, input: b.input ?? null, shares })
  if (existing) {
    // Already exactly this (a retry whose first response got lost, or the same edit twice): nothing to do.
    if (!existing.deletedAt && same(snapOf(existing), after)) return c.json({ ok: true, version: existing.version, pending: existing.pending, verifiedBy: existing.verifiedBy })
    // Stale edit: started from an older version. A deleted expense only comes back from its current version (a deliberate restore).
    if (existing.deletedAt ? b.base !== existing.version : b.base !== undefined && b.base !== existing.version) return conflict(c, eid)
  }
  const by = { byId: uid, byName: c.get('userName') }
  let version = 1
  try {
    await db.$transaction(async tx => {
      if (!existing) {
        await tx.expense.create({ data: { id: eid, groupId: gid, createdById: uid, updatedById: uid, ...data } })
        await audit(tx, gid, { kind: 'expense.created', expenseId: eid, version, ...by, via: b.via, after })
      } else {
        // Compare-and-set on the version: of two edits racing from the same base, only one gets through.
        const { count } = await tx.expense.updateMany({ where: { id: eid, version: existing.version }, data: { ...data, deletedAt: null, updatedById: uid, version: { increment: 1 } } })
        if (!count) throw new Stale()
        await tx.expenseShare.deleteMany({ where: { expenseId: eid } })
        version = existing.version + 1
        const action = existing.deletedAt ? 'restored' : b.revertOf ? 'reverted' : 'edited'
        // A deleted expense counts for nothing, so bringing it back starts from nothing.
        await audit(tx, gid, { kind: `expense.${action}`, expenseId: eid, version, revertOf: b.revertOf, ...by, via: b.via, before: existing.deletedAt ? null : snapOf(existing), after })
      }
      await tx.expenseShare.createMany({ data: shares.map(s => ({ expenseId: eid, ...s })) })
    })
  } catch (e) {
    const raced = e instanceof Stale || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
    if (!raced) throw e
    // Lost a race: identical content is fine (two phones making the same monthly repeat), anything else is a conflict.
    const now = await db.expense.findUnique({ where: { id: eid }, include: withShares })
    if (now && !now.deletedAt && same(snapOf(now), after)) return c.json({ ok: true, version: now.version, pending: now.pending, verifiedBy: now.verifiedBy })
    return conflict(c, eid)
  }
  if (rejected && !existing?.rejected) {
    const payer = all.find(m => m.id === Object.keys(b.paid)[0])
    const g = await db.group.findUnique({ where: { id: gid }, select: { name: true } })
    const to = payer?.userId && (await db.user.findUnique({ where: { id: payer.userId }, select: { email: true } }))?.email
    if (to) void mail.notReceived(to, c.get('userName'), g?.name ?? 'your group', b.amount).catch(console.error)
  }
  if (pending && !rejected && !existing?.pending && payee?.user?.email) {
    const g = await db.group.findUnique({ where: { id: gid }, select: { name: true } })
    const payer = all.find(m => m.id === Object.keys(b.paid)[0])
    const by = payer?.userId === uid ? c.get('userName') : (payer?.name ?? c.get('userName'))
    void mail.paid(payee.user.email, by, g?.name ?? 'your group', b.amount).catch(console.error)
  }
  return c.json({ ok: true, version, pending: data.pending, verifiedBy })
})

// Soft delete: the expense leaves balances but stays in history, can be restored, and reaches other phones as a tombstone.
api.delete('/groups/:gid/expenses/:eid', async c => {
  const [gid, eid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('eid'))]
  const uid = c.get('userId')
  if (!(await membership(gid, uid))) return c.json(notFound, 404)
  const q = c.req.query('base'), base = q === undefined || q === '' ? undefined : Number(q)
  const e = await db.expense.findUnique({ where: { id: eid }, include: withShares })
  if (!e || e.groupId !== gid || e.deletedAt) return c.json({ ok: true, version: e?.version }) // gone already: deleting twice is fine
  if (base !== undefined && base !== e.version) return conflict(c, eid) // they changed it since you last saw it
  try {
    await db.$transaction(async tx => {
      const { count } = await tx.expense.updateMany({ where: { id: eid, version: e.version }, data: { deletedAt: new Date(), updatedById: uid, version: { increment: 1 } } })
      if (!count) throw new Stale()
      await audit(tx, gid, { kind: 'expense.deleted', expenseId: eid, version: e.version + 1, byId: uid, byName: c.get('userName'), ...(c.req.query('via') === 'ai' && { via: 'ai' as const }), before: snapOf(e) })
    })
  } catch (err) { if (err instanceof Stale) return conflict(c, eid); throw err }
  return c.json({ ok: true, version: e.version + 1 })
})

// Undelete (from the activity feed or history).
api.post('/groups/:gid/expenses/:eid/restore', async c => {
  const [gid, eid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('eid'))]
  const uid = c.get('userId')
  if (!(await membership(gid, uid))) return c.json(notFound, 404)
  const e = await db.expense.findUnique({ where: { id: eid }, include: withShares })
  if (!e || e.groupId !== gid) return c.json(notFound, 404)
  if (!e.deletedAt) return c.json({ ok: true, version: e.version })
  const ok = await db.$transaction(async tx => {
    const { count } = await tx.expense.updateMany({ where: { id: eid, version: e.version }, data: { deletedAt: null, updatedById: uid, version: { increment: 1 } } })
    if (count) await audit(tx, gid, { kind: 'expense.restored', expenseId: eid, version: e.version + 1, byId: uid, byName: c.get('userName'), ...(c.req.query('via') === 'ai' && { via: 'ai' as const }), after: snapOf(e) })
    return count
  })
  if (!ok) return conflict(c, eid)
  return c.json({ ok: true, version: e.version + 1 })
})

// ---------- files: images only, sniffed, stored under our names ----------
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }
async function readImage(c: { req: { arrayBuffer: () => Promise<ArrayBuffer> } }, max: number) {
  const buf = Buffer.from(await c.req.arrayBuffer())
  if (!buf.length || buf.length > max) return { error: `Images up to ${max >> 20} MB` }
  const type = imageType(buf)
  return type ? { buf, type } : { error: 'That isn’t a photo we can use (JPEG, PNG or WebP)' }
}

// Profile picture: replaces the old upload, sets user.image.
api.post('/me/avatar', bodyLimit({ maxSize: 3 << 20, onError: c => c.json({ error: 'Images up to 3 MB' }, 413) }), async c => {
  if (!storageReady()) return c.json({ error: 'Photo uploads aren’t set up yet' }, 503)
  const img = await readImage(c, 3 << 20)
  if ('error' in img) return c.json({ error: img.error }, 400)
  const uid = c.get('userId')
  const path = `${uid}/${crypto.randomUUID()}.${EXT[img.type]}`
  await putFile(BUCKET.public, path, img.buf, img.type)
  const old = (await db.user.findUnique({ where: { id: uid }, select: { image: true } }))?.image
  const image = `/api/files/avatars/${path}`
  await db.user.update({ where: { id: uid }, data: { image } })
  if (old?.startsWith(`/api/files/avatars/${uid}/`)) void deleteFile(BUCKET.public, old.slice('/api/files/avatars/'.length))
  return c.json({ image })
})

// Group files (receipts, covers): private, members only.
api.post('/groups/:gid/files', bodyLimit({ maxSize: 6 << 20, onError: c => c.json({ error: 'Images up to 6 MB' }, 413) }), async c => {
  const gid = Id.parse(c.req.param('gid'))
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  if (!storageReady()) return c.json({ error: 'Photo uploads aren’t set up yet' }, 503)
  const img = await readImage(c, 6 << 20)
  if ('error' in img) return c.json({ error: img.error }, 400)
  const name = `${crypto.randomUUID()}.${EXT[img.type]}`
  await putFile(BUCKET.private, `${gid}/${name}`, img.buf, img.type)
  return c.json({ name })
})

api.get('/groups/:gid/files/:name', async c => {
  const gid = Id.parse(c.req.param('gid')), name = FileName.parse(c.req.param('name'))
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  const f = await getFile(BUCKET.private, `${gid}/${name}`)
  if (!f) return c.json(notFound, 404)
  return c.body(new Uint8Array(f.body), 200, { 'content-type': f.type, 'cache-control': 'private, max-age=86400' })
})

// ---------- reading expenses: a sentence, a receipt photo, a payment screenshot ----------
const reads = new Map<string, number[]>() // ponytail: per-process limiter; move to the DB if we run several instances
api.post('/ai/read', bodyLimit({ maxSize: 7 << 20, onError: c => c.json({ error: 'That photo is too large' }, 413) }), async c => {
  if (!aiReady()) return c.json({ error: 'Reading receipts isn’t set up yet' }, 503)
  const me = await db.user.findUnique({ where: { id: c.get('userId') }, select: { aiOffAt: true } })
  if (!me || me.aiOffAt) return c.json({ error: 'AI reading is off. Turn it on in Privacy and data.', code: 'ai-consent' }, 403)
  const b = ReadIn.parse(await c.req.json())
  const uid = c.get('userId'), now = Date.now()
  const recent = (reads.get(uid) ?? []).filter(t => now - t < 3600_000)
  if (recent.length >= 40) return c.json({ error: 'That’s a lot of scans for one hour. Try again a little later.' }, 429)
  reads.set(uid, [...recent, now])
  let members: string[] = []
  if (b.groupId) {
    if (!(await membership(b.groupId, uid))) return c.json(notFound, 404)
    // guests have no userId; NOT { userId } alone would drop them (SQL NULL)
    members = (await db.member.findMany({ where: { groupId: b.groupId, OR: [{ userId: null }, { userId: { not: uid } }] }, select: { name: true } })).map(m => m.name)
  }
  try {
    const read = await readExpense({ text: b.text, image: b.image, members, today: b.today })
    count.ai.add(1, { result: 'read' })
    return c.json(read)
  } catch (e) {
    count.ai.add(1, { result: 'error' })
    console.error('[ai]', (e as Error).message)
    return c.json({ error: 'Couldn’t read that right now. You can still type it in.' }, 502)
  }
})

// ---------- personal claim links: whoever holds the token takes that guest spot ----------

api.get('/claim/:token', async c => {
  const m = await db.member.findUnique({ where: { inviteToken: Token.parse(c.req.param('token')) }, include: { group: true } })
  if (!m || m.userId) return c.json({ error: 'This invite was already used or is no longer valid' }, 404)
  return c.json({ group: { id: m.group.id, name: m.group.name, kind: m.group.kind, theme: m.group.theme }, name: m.name })
})

api.post('/claim/:token', async c => {
  const uid = c.get('userId')
  const m = await db.member.findUnique({ where: { inviteToken: Token.parse(c.req.param('token')) } })
  if (!m || m.userId) return c.json({ error: 'This invite was already used or is no longer valid' }, 404)
  if (await membership(m.groupId, uid)) return c.json({ id: m.groupId }) // already in via another spot
  const count = await db.$transaction(async tx => {
    const { count } = await tx.member.updateMany({ where: { id: m.id, userId: null }, data: { userId: uid, inviteToken: null, name: c.get('userName') } })
    if (count) await audit(tx, m.groupId, { kind: 'member.joined', memberId: m.id, byId: uid, byName: c.get('userName'), after: { name: m.name, email: m.email, how: 'invite link' } })
    return count
  })
  if (!count) return c.json({ error: 'Someone already claimed this invite' }, 409)
  return c.json({ id: m.groupId })
})

// ---------- group invite links: anyone with the link joins as themselves ----------
// A spot someone was invited to by email is only theirs: claimed by its personal link, or here when the email matches.
api.get('/invites/:code', async c => {
  const g = await db.group.findUnique({ where: { inviteCode: InviteCode.parse(c.req.param('code')) }, include: { members: { select: { userId: true } } } })
  if (!g || g.kind === 'direct') return c.json({ error: 'This invite link is no longer valid' }, 404)
  return c.json({ id: g.id, name: g.name, kind: g.kind, theme: g.theme, people: g.members.length, joined: g.members.some(m => m.userId === c.get('userId')) })
})

api.post('/invites/:code/join', async c => {
  const g = await db.group.findUnique({ where: { inviteCode: InviteCode.parse(c.req.param('code')) }, include: { members: true } })
  if (!g || g.kind === 'direct') return c.json({ error: 'This invite link is no longer valid' }, 404)
  const uid = c.get('userId')
  if (g.members.some(m => m.userId === uid)) return c.json({ id: g.id })
  const me = await db.user.findUniqueOrThrow({ where: { id: uid }, select: { email: true, emailVerified: true, name: true, verifiedPhone: true } })
  // Their spot by verified email, else by the number they proved on WhatsApp.
  const spot = (me.emailVerified ? g.members.find(m => !m.userId && m.email?.toLowerCase() === me.email.toLowerCase()) : undefined)
    ?? (me.verifiedPhone ? g.members.find(m => !m.userId && m.phone === me.verifiedPhone) : undefined)
  await db.$transaction(async tx => {
    if (spot) {
      const { count } = await tx.member.updateMany({ where: { id: spot.id, userId: null }, data: { userId: uid, inviteToken: null, name: me.name } })
      if (count) return audit(tx, g.id, { kind: 'member.joined', memberId: spot.id, byId: uid, byName: me.name, after: { name: spot.name, email: spot.email, how: 'group link' } })
    }
    const id = crypto.randomUUID()
    await tx.member.create({ data: { id, groupId: g.id, name: me.name, email: me.email.toLowerCase(), userId: uid } })
    await audit(tx, g.id, { kind: 'member.joined', memberId: id, byId: uid, byName: me.name, after: { name: me.name, how: 'group link' } })
  })
  return c.json({ id: g.id })
})

// ---------- friends: a two-person group per pair, for expenses outside any group ----------
type Me = { id: string; name: string; email: string }
/** Who the friend is: an account (joined from the start), or an email or phone number they'll join with. */
type Friend = { name: string; userId?: string; email?: string; phone?: string }
const directKey = (a: string, b: string) => createHash('sha256').update([a, b].sort().join('\n')).digest('hex')
const meFor = (uid: string) => db.user.findUniqueOrThrow({ where: { id: uid }, select: { id: true, email: true, name: true, verifiedPhone: true } })
/** The friends group with this person, made if there isn't one yet. `made` is the friend's new spot. */
async function directWith(me: Me, f: Friend): Promise<{ id: string; made?: string }> {
  // Found by membership, not by key: older email-keyed groups, and spots that have since joined, still match.
  const them: Prisma.MemberWhereInput = f.userId ? { userId: f.userId }
    : f.email ? { OR: [{ email: { equals: f.email, mode: 'insensitive' } }, { user: { email: { equals: f.email, mode: 'insensitive' } } }] }
    : { OR: [{ phone: f.phone }, { user: { verifiedPhone: f.phone } }] }
  const found = await db.group.findFirst({ where: { kind: 'direct', AND: [{ members: { some: { userId: me.id } } }, { members: { some: them } }] }, select: { id: true } })
  if (found) return found
  // ponytail: the key only stops the same add racing itself. Two people adding each other at the same moment by
  // different identifiers (my email, their phone) can make two friends balances. Merge when that's reported.
  const key = directKey(`u:${me.id}`, f.userId ? `u:${f.userId}` : f.email ? `e:${f.email}` : `p:${f.phone}`)
  const id = crypto.randomUUID(), selfId = crypto.randomUUID(), friendId = crypto.randomUUID()
  const by = { byId: me.id, byName: me.name }
  const friend = { id: friendId, name: f.name, email: f.email ?? null, phone: f.phone ?? null, ...(f.userId ? { userId: f.userId } : { addedById: me.id }) }
  try {
    await db.$transaction(async tx => {
      await tx.group.create({ data: { id, name: f.name, kind: 'direct', theme: 'classic', directKey: key, inviteCode: inviteCode(), createdById: me.id,
        members: { create: [{ id: selfId, name: me.name, userId: me.id, email: me.email.toLowerCase() }, friend] } } })
      await audit(tx, id, { kind: 'group.created', memberId: selfId, ...by, after: { kind: 'direct' } })
      await audit(tx, id, { kind: 'member.invited', memberId: friendId, ...by, after: { name: f.name, ...(f.email && { email: f.email }), ...(f.phone && { phone: f.phone }) } })
    })
  } catch (e) {
    // The same add twice at the same moment (two taps, two phones): the other request made it first.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return db.group.findUniqueOrThrow({ where: { directKey: key }, select: { id: true } })
    throw e
  }
  return { id, made: friendId }
}

// A friend by exactly one of: email, phone, or (someone you already share a group with) their account.
api.post('/friends', async c => {
  const b = FriendIn.parse(await c.req.json())
  if ([b.email, b.phone, b.userId].filter(Boolean).length !== 1) return c.json({ error: 'Add their phone number or email.' }, 400)
  const me = await meFor(c.get('userId'))
  if (b.userId) {
    // Only people you already split with: anyone else would be a lookup of who's on Plico.
    const them = b.userId === me.id ? null
      : await db.user.findFirst({ where: { id: b.userId, members: { some: { group: { members: { some: { userId: me.id } } } } } }, select: { id: true, name: true, email: true } })
    if (!them) return c.json(notFound, 404)
    return c.json({ id: (await directWith(me, { name: them.name, userId: them.id, email: them.email.toLowerCase() })).id })
  }
  if (b.phone) {
    // Never matched to an account here: that would tell anyone whether a number is on Plico, and whose it is.
    if (b.phone === me.verifiedPhone) return c.json({ error: 'That’s your own number.' }, 400)
    const g = await directWith(me, { name: b.name, phone: b.phone })
    // Still waiting for them: their personal link, so the app can open WhatsApp straight to them.
    const spot = await db.member.findFirst({ where: { groupId: g.id, userId: null, phone: b.phone }, select: { id: true } })
    return c.json({ id: g.id, ...(spot && { link: claimUrl(await ensureToken(spot.id)) }) })
  }
  const email = b.email!.trim().toLowerCase()
  if (email === me.email.toLowerCase()) return c.json({ error: 'That’s your own email.' }, 400)
  const g = await directWith(me, { name: b.name, email })
  if (g.made) await inviteByEmail(g.id, g.made, email, { id: me.id, name: me.name })
  return c.json({ id: g.id })
})

// ---------- personal friend links: whoever opens /#/u/<code> becomes your friend ----------
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** A fresh code (or, unless `replace`, the one they already have). Retries the rare clash with someone else's. */
async function friendCode(uid: string, replace: boolean) {
  for (let i = 0; ; i++) {
    try {
      await db.user.updateMany({ where: { id: uid, ...(!replace && { friendCode: null }) }, data: { friendCode: Array.from({ length: 10 }, () => ALNUM[randomInt(36)]).join('') } })
      return (await db.user.findUniqueOrThrow({ where: { id: uid }, select: { friendCode: true } })).friendCode!
    } catch (e) {
      if (i < 3 && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue
      throw e
    }
  }
}
api.get('/me/friend-code', async c => {
  const u = await db.user.findUniqueOrThrow({ where: { id: c.get('userId') }, select: { friendCode: true } })
  return c.json({ code: u.friendCode ?? await friendCode(c.get('userId'), false) })
})
// A leaked link lets anyone add you: a new one retires it at once.
api.post('/me/friend-code/reset', async c => c.json({ code: await friendCode(c.get('userId'), true) }))

api.post('/friends/code/:code', async c => {
  const code = FriendCode.safeParse(c.req.param('code'))
  const them = code.success ? await db.user.findUnique({ where: { friendCode: code.data }, select: { id: true, name: true, email: true } }) : null
  if (!them) return c.json({ error: 'This link is no longer valid' }, 404)
  const me = await meFor(c.get('userId'))
  if (them.id === me.id) return c.json({ error: 'That’s your own link.' }, 400)
  const g = await directWith(me, { name: them.name, userId: them.id, email: them.email.toLowerCase() })
  // They shared the link, so they'll want to know it worked. Like other pushes, only for people with a device.
  if (g.made && await db.pushDevice.count({ where: { userId: them.id } }))
    await db.notification.create({ data: { userId: them.id, kind: 'friend.added', groupId: g.id, byId: me.id, data: { by: me.name } } })
  return c.json({ id: g.id })
})

// ---------- push notifications ----------
/** This device wants pushes. A token moves to whoever registers it last (a shared or handed-down phone). */
api.post('/me/push-devices', async c => {
  const b = PushDeviceIn.parse(await c.req.json())
  const uid = c.get('userId'), sessionId = c.get('sessionId')
  const data = { userId: uid, sessionId, platform: b.platform, keys: b.keys ?? Prisma.DbNull, lastSeenAt: new Date() }
  // A browser subscription moves to another account only with its own secret: knowing the address isn't enough.
  const held = await db.pushDevice.findUnique({ where: { token: b.token }, select: { userId: true, keys: true } })
  if (held && held.userId !== uid && b.platform === 'web' && (held.keys as { auth?: string } | null)?.auth !== b.keys?.auth)
    return c.json({ error: 'That notification subscription belongs to another account' }, 409)
  await db.pushDevice.upsert({ where: { token: b.token }, create: { token: b.token, ...data }, update: data })
  if (b.tz) await db.user.update({ where: { id: uid }, data: { tz: b.tz } })
  return c.json({ ok: true })
})

api.delete('/me/push-devices', async c => {
  const { token } = PushTokenIn.parse(await c.req.json())
  await db.pushDevice.deleteMany({ where: { token, userId: c.get('userId') } })
  return c.json({ ok: true })
})

api.get('/me/notify', async c => {
  const uid = c.get('userId')
  const [u, devices] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: uid }, select: { notify: true } }),
    db.pushDevice.findMany({ where: { userId: uid }, select: { sessionId: true }, distinct: ['sessionId'] }),
  ])
  return c.json({ prefs: prefsOf(u.notify), sessions: devices.map(d => d.sessionId) })
})

api.put('/me/notify', async c => {
  const b = NotifyIn.parse(await c.req.json())
  const uid = c.get('userId')
  const u = await db.user.findUniqueOrThrow({ where: { id: uid }, select: { notify: true } })
  const prefs = { ...prefsOf(u.notify), ...Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) }
  await db.user.update({ where: { id: uid }, data: { notify: prefs } })
  return c.json({ prefs })
})

/** Each member's balance in a group, in paise (what balances() in logic.ts computes, on the server). */
const nets = async (gid: string) => new Map((await db.$queryRaw<{ memberId: string; net: number }[]>`
  SELECT s."memberId", SUM(s."paid" - s."owed")::int AS net FROM "splittr"."expense_share" s JOIN "splittr"."expense" e ON e."id" = s."expenseId"
  WHERE e."groupId" = ${gid} AND e."deletedAt" IS NULL AND NOT e."rejected" GROUP BY s."memberId"`).map(r => [r.memberId, r.net]))

const DAY = 864e5
/** Remind someone who owes you. Once per person per group a day, and three a week to anyone in a group. */
api.post('/groups/:gid/remind', async c => {
  const gid = Id.parse(c.req.param('gid'))
  const { memberId, amount } = RemindIn.parse(await c.req.json())
  const uid = c.get('userId')
  const me = await membership(gid, uid)
  if (!me) return c.json(notFound, 404)
  const [g, them] = await Promise.all([db.group.findUnique({ where: { id: gid }, select: { track: true } }), db.member.findFirst({ where: { id: memberId, groupId: gid } })])
  if (!g || !them || them.id === me.id) return c.json(notFound, 404)
  if (g.track) return c.json({ error: 'This group only tracks spending, so it doesn’t send reminders.', code: 'tracking' }, 409)
  if (!them.userId) return c.json({ error: `${them.name} isn’t on Plico yet. Remind them on WhatsApp.`, code: 'not-on-plico' }, 409)
  if (!(await db.pushDevice.count({ where: { userId: them.userId } }))) return c.json({ error: `${them.name} doesn’t have Plico notifications on. Remind them on WhatsApp.`, code: 'no-device' }, 409)
  const net = await nets(gid)
  if ((net.get(them.id) ?? 0) >= 0 || (net.get(me.id) ?? 0) <= 0) return c.json({ error: `You and ${them.name} are square here.`, code: 'square' }, 409)
  return db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`remind:${gid}:${them.userId}`}))` // two taps can't both pass the limits
    const recent = await tx.notification.findMany({ where: { kind: 'remind', groupId: gid, userId: them.userId!, createdAt: { gt: new Date(Date.now() - 7 * DAY) } }, orderBy: { createdAt: 'asc' }, select: { byId: true, createdAt: true } })
    const mineToday = recent.filter(r => r.byId === uid && r.createdAt.getTime() > Date.now() - DAY).at(-1)
    const retryAt = mineToday ? new Date(mineToday.createdAt.getTime() + DAY) : recent.length >= 3 ? new Date(recent[recent.length - 3].createdAt.getTime() + 7 * DAY) : null
    if (retryAt) return c.json({ error: `${them.name} was reminded recently. You can nudge again ${retryAt.toLocaleString('en-IN', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}.`, code: 'limit', retryAt }, 429)
    await tx.notification.create({ data: { userId: them.userId!, kind: 'remind', groupId: gid, byId: uid, data: { by: c.get('userName'), amount: Math.min(amount, -(net.get(them.id) ?? 0)) } } })
    return c.json({ ok: true as const })
  })
})

// ---------- Ask Plico ----------
const chats = new Map<string, number[]>() // ponytail: per-process limiter, like AI reading; move to the DB with several instances
api.post('/chat', bodyLimit({ maxSize: 8 << 20, onError: c => c.json({ error: 'That photo is too large' }, 413) }), async c => {
  if (!aiReady()) return c.json({ error: 'Chat isn’t set up yet' }, 503)
  const uid = c.get('userId')
  const me = await db.user.findUnique({ where: { id: uid }, select: { aiOffAt: true } })
  if (!me || me.aiOffAt) return c.json({ error: 'AI features are off. Turn them on in Privacy and data.', code: 'ai-consent' }, 403)
  const b = ChatIn.parse(await c.req.json())
  const now = Date.now(), recent = (chats.get(uid) ?? []).filter(t => now - t < 864e5)
  if (recent.filter(t => now - t < 3600_000).length >= 30 || recent.length >= 150)
    return c.json({ error: 'That’s a lot of questions for now. Try again a little later.', code: 'limit' }, 429)
  chats.set(uid, [...recent, now])
  return streamSSE(c, async s => {
    try {
      let outcome = 'answered'
      for await (const ev of chat(uid, b.messages, b.today, b.image)) {
        if (ev.type === 'declined') outcome = 'declined'
        else if (ev.type === 'error') outcome = 'error'
        else if (ev.type === 'tool') count.tool.add(1, { tool: ev.name })
        await s.writeSSE({ data: JSON.stringify(ev) })
      }
      count.chat.add(1, { result: outcome })
    } catch (e) {
      console.error('[chat]', (e as Error).message)
      count.chat.add(1, { result: 'error' })
      await s.writeSSE({ data: JSON.stringify({ type: 'error', message: 'I couldn’t answer that right now. Try again in a moment.' }) })
    }
  })
})
