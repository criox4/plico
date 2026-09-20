import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { auth } from './auth.ts'
import { db } from './db.ts'
import { mail } from './email.ts'
import { aiReady, readExpense } from './ai.ts'
import { BUCKET, deleteFile, getFile, imageType, putFile, storageReady } from './storage.ts'
import { Prisma } from './generated/prisma/client.ts'
import { isVpa, sharesError } from '../src/logic.ts'
import { THEMES } from '../src/themes.ts'

type Env = { Variables: { userId: string; userName: string } }
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
  const b = z.object({ consent: z.boolean(), name: z.string().trim().min(2).max(80).optional(), adult: z.boolean().optional() }).parse(await c.req.json())
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

export const api = new Hono<Env>()

const Id = z.string().regex(/^[\w:-]{1,64}$/)
const Kind = z.enum(['trip', 'home', 'couple', 'friends', 'office', 'family'])
const Theme = z.enum(THEMES.map(t => t.id) as [string, ...string[]])
const Upi = z.string().trim().max(256).refine(v => !v || isVpa(v), 'Not a valid UPI ID').nullish()
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Paise = z.number().int().min(0).max(2_000_000_000)

const Emoji = z.string().regex(/^(?=.*\p{Extended_Pictographic})\S{1,16}$/u)
const GroupIn = z.object({ name: z.string().trim().min(1).max(60), kind: Kind, theme: Theme, track: z.boolean().optional(), emoji: Emoji.nullish(), cover: z.string().regex(/^[0-9a-f-]{36}\.(jpg|png|webp)$/).nullish(), selfId: Id })
const Email = z.string().trim().toLowerCase().max(254).refine(v => !v || z.email().safeParse(v).success, 'Not a valid email').nullish()
const Phone = z.string().trim().max(20).refine(v => !v || /^\+?[0-9 ()-]{7,20}$/.test(v), 'Not a valid phone number').nullish()
const MemberIn = z.object({ name: z.string().trim().min(1).max(60), upi: Upi, email: Email, phone: Phone })
const APP = process.env.PUBLIC_URL || 'http://localhost:5173'
const claimUrl = (token: string) => `${APP}/#/claim/${token}`
const FileName = z.string().regex(/^[0-9a-f-]{36}\.(jpg|png|webp)$/)
const ExpenseIn = z.object({
  title: z.string().trim().min(1).max(120), cat: z.string().max(20), date: Day, amount: Paise.min(1),
  paid: z.record(Id, Paise), owed: z.record(Id, Paise),
  mode: z.enum(['equal', 'exact', 'percent', 'shares']).nullish(), input: z.record(Id, z.number()).nullish(),
  settle: z.boolean().optional(), pending: z.boolean().optional(), rejected: z.boolean().optional(), receipt: FileName.nullish(), repeat: z.object({ next: Day, day: z.number().int().min(1).max(31) }).nullish(),
  // The version this edit started from: null for a new expense. Absent only from pre-versioning clients (last write wins).
  base: z.number().int().min(0).nullish(),
  revertOf: z.number().int().min(1).optional(), // "restore this version" from the history screen
})
const JoinIn = z.object({ memberId: Id.optional() })

const inviteCode = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const notFound = { error: 'Not found' }

api.use('*', async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!s) return c.json({ error: 'Sign in first' }, 401)
  c.set('userId', s.user.id)
  c.set('userName', s.user.name)
  // Age gate (DPDP Act s.9): nobody uses Plico before saying how old they are, and 13-17 year olds wait for a parent.
  const u = s.user as typeof s.user & { ageGroup?: string | null; guardianConsentAt?: Date | null }
  const open = /^\/api\/me\/(age|guardian|export)$/.test(c.req.path)
  if (!open && !u.ageGroup) return c.json({ error: 'Tell us your age first', code: 'age' }, 403)
  if (!open && u.ageGroup === 'teen' && !u.guardianConsentAt) return c.json({ error: 'Waiting for a parent’s consent', code: 'guardian' }, 403)
  await next()
})

// ---------- age, parental consent, AI consent, data export ----------
const GuardianEmail = z.string().trim().toLowerCase().max(254).refine(v => z.email().safeParse(v).success, 'Enter your parent’s email')
async function askGuardian(uid: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: uid }, select: { name: true, email: true, guardianEmail: true } })
  if (!u.guardianEmail) return
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  await db.verification.deleteMany({ where: { identifier: `guardian:${uid}` } })
  await db.verification.create({ data: { id: crypto.randomUUID(), identifier: `guardian:${uid}`, value: token, expiresAt: new Date(Date.now() + 14 * 864e5) } })
  void mail.guardian(u.guardianEmail, u.name, u.email, `${APP}/#/guardian/${token}`).catch(console.error)
}

api.post('/me/age', async c => {
  const b = z.object({ group: z.enum(['adult', 'teen']), guardianEmail: GuardianEmail.optional() }).parse(await c.req.json())
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
  const b = z.object({ email: GuardianEmail.optional() }).parse(await c.req.json().catch(() => ({})))
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

api.post('/me/ai', async c => {
  const { consent } = z.object({ consent: z.boolean() }).parse(await c.req.json())
  await db.user.update({ where: { id: c.get('userId') }, data: { aiConsentAt: consent ? new Date() : null } })
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
      members: { select: { id: true, name: true, upi: true, email: true, phone: true, userId: true } },
      expenses: { select: { id: true, title: true, cat: true, date: true, amount: true, settle: true, pending: true, rejected: true, receipt: true, createdAt: true, version: true, deletedAt: true, shares: { select: { memberId: true, paid: true, owed: true } } } } },
  })
  const history = await db.expenseEvent.findMany({ where: { byId: uid }, orderBy: { at: 'asc' }, select: { groupId: true, expenseId: true, version: true, action: true, at: true, before: true, after: true } })
  const data = { exportedAt: new Date(), note: 'Amounts are in paise (₹1 = 100 paise). Photos are listed by file name; download them from the app. "history" lists the changes you made.', user, signIns: accounts, sessions, groups, history }
  return c.body(JSON.stringify(data, null, 2), 200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="plico-export.json"' })
})

api.onError((e, c) => {
  if (e instanceof z.ZodError) return c.json({ error: e.issues[0]?.message ?? 'Invalid input' }, 400)
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
const snapOf = (e: Omit<Stored, 'id' | 'groupId' | 'createdById' | 'createdAt' | 'updatedAt' | 'version' | 'deletedAt' | 'updatedById'>) => ({
  title: e.title, cat: e.cat, date: e.date, amount: e.amount, mode: e.mode, input: sortKeys(e.input), settle: e.settle, pending: e.pending, rejected: e.rejected,
  receipt: e.receipt, repeatNext: e.repeatNext, repeatDay: e.repeatDay,
  shares: [...e.shares].filter(x => x.paid || x.owed).sort((a, b) => a.memberId.localeCompare(b.memberId)).map(x => ({ memberId: x.memberId, paid: x.paid, owed: x.owed })),
})
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
class Stale extends Error {}

/** 409: someone changed (or deleted) it after the version this edit started from. Carries their version and who made it. */
async function conflict(c: { json: (b: unknown, s: 409) => Response }, eid: string) {
  const [theirs, last] = await Promise.all([
    db.expense.findUnique({ where: { id: eid }, include: withShares }),
    db.expenseEvent.findFirst({ where: { expenseId: eid }, orderBy: { version: 'desc' }, select: { byName: true, at: true, action: true } }),
  ])
  return c.json({ error: 'Someone else changed this first', code: 'conflict', theirs, by: last?.byName ?? 'Someone', at: last?.at ?? theirs?.updatedAt, action: last?.action }, 409)
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
    include: { members: { orderBy: { createdAt: 'asc' }, omit: { inviteToken: true }, include: { user: { select: { image: true } } } } },
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

// A group's activity feed, newest first (paged by `before`).
api.get('/groups/:gid/activity', async c => {
  const gid = Id.parse(c.req.param('gid'))
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  const before = c.req.query('before')
  const events = await db.expenseEvent.findMany({
    where: { groupId: gid, ...(before && { at: { lt: new Date(before) } }) }, orderBy: { at: 'desc' }, take: 40,
  })
  return c.json(events)
})

// Every version of one expense, oldest first.
api.get('/groups/:gid/expenses/:eid/history', async c => {
  const [gid, eid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('eid'))]
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  return c.json(await db.expenseEvent.findMany({ where: { groupId: gid, expenseId: eid }, orderBy: { version: 'asc' } }))
})

api.put('/groups/:id', async c => {
  const id = Id.parse(c.req.param('id'))
  const b = GroupIn.parse(await c.req.json())
  const uid = c.get('userId')
  const exists = await db.group.findUnique({ where: { id }, select: { id: true } })
  if (exists) {
    if (!(await membership(id, uid))) return c.json(notFound, 404)
    await db.group.update({ where: { id }, data: { name: b.name, kind: b.kind, theme: b.theme, track: !!b.track, emoji: b.emoji ?? null, cover: b.cover ?? null } })
  } else {
    await db.group.create({
      data: { id, name: b.name, kind: b.kind, theme: b.theme, track: !!b.track, emoji: b.emoji ?? null, cover: b.cover ?? null, inviteCode: inviteCode(), createdById: uid,
        members: { create: { id: b.selfId, name: c.get('userName'), userId: uid } } },
    })
  }
  return c.json({ ok: true })
})

api.delete('/groups/:id', async c => {
  const g = await db.group.findUnique({ where: { id: Id.parse(c.req.param('id')) } })
  if (!g) return c.json({ ok: true }) // idempotent: already gone
  if (g.createdById !== c.get('userId')) return c.json({ error: 'Only the person who made the group can delete it' }, 403)
  await db.group.delete({ where: { id: g.id } })
  return c.json({ ok: true })
})

api.get('/groups/:id/invite', async c => {
  const id = Id.parse(c.req.param('id'))
  if (!(await membership(id, c.get('userId')))) return c.json(notFound, 404)
  const g = await db.group.findUniqueOrThrow({ where: { id }, select: { inviteCode: true } })
  return c.json({ code: g.inviteCode })
})

api.put('/groups/:gid/members/:mid', async c => {
  const [gid, mid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('mid'))]
  const b = MemberIn.parse(await c.req.json())
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  const m = await db.member.findUnique({ where: { id: mid } })
  if (m && m.groupId !== gid) return c.json(notFound, 404)
  // Someone with an account owns their details. Letting others edit a joined person's UPI ID would let them
  // redirect that person's incoming payments, so those edits are ignored (not errors: they may be stale outbox ops).
  if (m?.userId && m.userId !== c.get('userId')) return c.json({ ok: true, ignored: true })
  const data = { name: b.name, upi: b.upi || null, email: b.email || null, phone: b.phone || null }
  if (m) await db.member.update({ where: { id: mid }, data })
  else await db.member.create({ data: { id: mid, groupId: gid, ...data } })
  // A new email on a guest: link now if that person already has a verified account, otherwise email an invite.
  if (data.email && data.email !== m?.email && !m?.userId) await inviteByEmail(gid, mid, data.email, c.get('userName'))
  return c.json({ ok: true })
})

async function inviteByEmail(gid: string, mid: string, email: string, inviter: string) {
  const g = await db.group.findUniqueOrThrow({ where: { id: gid }, select: { name: true } })
  const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' }, emailVerified: true } })
  if (user) {
    const { count } = await db.member.updateMany({
      where: { id: mid, userId: null, group: { members: { none: { userId: user.id } } } }, data: { userId: user.id, inviteToken: null },
    })
    if (count) void mail.added(user.email, inviter, g.name).catch(console.error)
    return
  }
  const token = await ensureToken(mid)
  await db.member.update({ where: { id: mid }, data: { invitedAt: new Date() } })
  void mail.invite(email, inviter, g.name, claimUrl(token)).catch(console.error)
}

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
  const { email } = z.object({ email: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})))
  if (email && m.email) {
    if (m.invitedAt && Date.now() - m.invitedAt.getTime() < 60_000) return c.json({ error: 'Invite just sent. Try again in a minute.' }, 429)
    await inviteByEmail(gid, mid, m.email, c.get('userName'))
  }
  return c.json({ link: claimUrl(await ensureToken(mid)) })
})

api.delete('/groups/:gid/members/:mid', async c => {
  const [gid, mid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('mid'))]
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  const m = await db.member.findUnique({ where: { id: mid }, include: { _count: { select: { shares: true } } } })
  if (!m || m.groupId !== gid) return c.json({ ok: true })
  if (m.userId || m._count.shares) return c.json({ error: 'People with expenses or an account can’t be removed' }, 409)
  await db.member.delete({ where: { id: mid } })
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

  // Only the payee can confirm a settlement (or nobody can, when the payee is a guest). Anyone else's
  // record waits for them; an already confirmed one stays confirmed while its amount is unchanged.
  const payee = b.settle ? all.find(m => m.id === Object.keys(b.owed)[0]) : undefined
  const canConfirm = !payee?.userId || payee.userId === uid
  const pending = !!b.settle && (canConfirm ? !!b.pending : !(existing && !existing.pending && existing.amount === b.amount))
  // Only the payee can say it hasn't arrived.
  const rejected = !!b.settle && (payee?.userId === uid ? !!b.rejected : !!existing?.rejected)

  const ids = new Set([...Object.keys(b.paid), ...Object.keys(b.owed)])
  const shares = [...ids].map(memberId => ({ memberId, paid: b.paid[memberId] ?? 0, owed: b.owed[memberId] ?? 0 }))
  const data = {
    title: b.title, cat: b.cat, date: b.date, amount: b.amount, mode: b.mode ?? null, input: b.input ?? Prisma.DbNull,
    settle: !!b.settle, pending: pending && !rejected, rejected, receipt: b.receipt ?? null, repeatNext: b.repeat?.next ?? null, repeatDay: b.repeat?.day ?? null,
  }
  const after = snapOf({ ...data, input: b.input ?? null, shares })
  if (existing) {
    // Already exactly this (a retry whose first response got lost, or the same edit twice): nothing to do.
    if (!existing.deletedAt && same(snapOf(existing), after)) return c.json({ ok: true, version: existing.version, pending: existing.pending })
    // Stale edit: started from an older version. A deleted expense only comes back from its current version (a deliberate restore).
    if (existing.deletedAt ? b.base !== existing.version : b.base !== undefined && b.base !== existing.version) return conflict(c, eid)
  }
  const by = { byId: uid, byName: c.get('userName') }
  let version = 1
  try {
    await db.$transaction(async tx => {
      if (!existing) {
        await tx.expense.create({ data: { id: eid, groupId: gid, createdById: uid, updatedById: uid, ...data } })
        await tx.expenseEvent.create({ data: { expenseId: eid, groupId: gid, version, action: 'created', ...by, after } })
      } else {
        // Compare-and-set on the version: of two edits racing from the same base, only one gets through.
        const { count } = await tx.expense.updateMany({ where: { id: eid, version: existing.version }, data: { ...data, deletedAt: null, updatedById: uid, version: { increment: 1 } } })
        if (!count) throw new Stale()
        await tx.expenseShare.deleteMany({ where: { expenseId: eid } })
        version = existing.version + 1
        const action = existing.deletedAt ? 'restored' : b.revertOf ? 'reverted' : 'edited'
        await tx.expenseEvent.create({ data: { expenseId: eid, groupId: gid, version, action, revertOf: b.revertOf, ...by, before: snapOf(existing), after } })
      }
      await tx.expenseShare.createMany({ data: shares.map(s => ({ expenseId: eid, ...s })) })
    })
  } catch (e) {
    const raced = e instanceof Stale || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
    if (!raced) throw e
    // Lost a race: identical content is fine (two phones making the same monthly repeat), anything else is a conflict.
    const now = await db.expense.findUnique({ where: { id: eid }, include: withShares })
    if (now && !now.deletedAt && same(snapOf(now), after)) return c.json({ ok: true, version: now.version, pending: now.pending })
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
  return c.json({ ok: true, version, pending })
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
      await tx.expenseEvent.create({ data: { expenseId: eid, groupId: gid, version: e.version + 1, action: 'deleted', byId: uid, byName: c.get('userName'), before: snapOf(e) } })
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
  const { count } = await db.expense.updateMany({ where: { id: eid, version: e.version }, data: { deletedAt: null, updatedById: uid, version: { increment: 1 } } })
  if (!count) return conflict(c, eid)
  await db.expenseEvent.create({ data: { expenseId: eid, groupId: gid, version: e.version + 1, action: 'restored', byId: uid, byName: c.get('userName'), after: snapOf(e) } })
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
const ReadIn = z.object({
  text: z.string().trim().min(1).max(500).optional(),
  image: z.string().regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/).max(7_000_000).optional(),
  groupId: Id.optional(), today: Day,
}).refine(b => b.text || b.image, 'Send a sentence or a photo')
const reads = new Map<string, number[]>() // ponytail: per-process limiter; move to the DB if we run several instances
api.post('/ai/read', bodyLimit({ maxSize: 7 << 20, onError: c => c.json({ error: 'That photo is too large' }, 413) }), async c => {
  if (!aiReady()) return c.json({ error: 'Reading receipts isn’t set up yet' }, 503)
  const me = await db.user.findUnique({ where: { id: c.get('userId') }, select: { aiConsentAt: true } })
  if (!me?.aiConsentAt) return c.json({ error: 'Turn on AI reading first', code: 'ai-consent' }, 403)
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
    return c.json(await readExpense({ text: b.text, image: b.image, members, today: b.today }))
  } catch (e) {
    console.error('[ai]', (e as Error).message)
    return c.json({ error: 'Couldn’t read that right now. You can still type it in.' }, 502)
  }
})

// ---------- personal claim links: whoever holds the token takes that guest spot ----------
const Token = z.string().regex(/^[a-f0-9]{32}$/)

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
  const { count } = await db.member.updateMany({ where: { id: m.id, userId: null }, data: { userId: uid, inviteToken: null } })
  if (!count) return c.json({ error: 'Someone already claimed this invite' }, 409)
  return c.json({ id: m.groupId })
})

// ---------- group invite links: a friend signs in and picks their guest profile ----------
api.get('/invites/:code', async c => {
  const g = await db.group.findUnique({ where: { inviteCode: z.string().max(40).parse(c.req.param('code')) }, include: { members: true } })
  if (!g) return c.json({ error: 'This invite link is no longer valid' }, 404)
  return c.json({
    id: g.id, name: g.name, kind: g.kind, theme: g.theme,
    joined: g.members.some(m => m.userId === c.get('userId')),
    guests: g.members.filter(m => !m.userId).map(m => ({ id: m.id, name: m.name })),
  })
})

api.post('/invites/:code/join', async c => {
  const g = await db.group.findUnique({ where: { inviteCode: z.string().max(40).parse(c.req.param('code')) }, include: { members: true } })
  if (!g) return c.json({ error: 'This invite link is no longer valid' }, 404)
  const uid = c.get('userId')
  if (g.members.some(m => m.userId === uid)) return c.json({ id: g.id })
  const { memberId } = JoinIn.parse(await c.req.json().catch(() => ({})))
  if (memberId) {
    // Claim only an unclaimed guest; the conditional update makes a race between two claimers safe.
    const { count } = await db.member.updateMany({ where: { id: memberId, groupId: g.id, userId: null }, data: { userId: uid } })
    if (!count) return c.json({ error: 'Someone already claimed that name' }, 409)
  } else {
    await db.member.create({ data: { id: crypto.randomUUID(), groupId: g.id, name: c.get('userName'), userId: uid } })
  }
  return c.json({ id: g.id })
})
