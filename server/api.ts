import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from './auth.ts'
import { db } from './db.ts'
import { mail } from './email.ts'
import { Prisma } from './generated/prisma/client.ts'
import { isVpa, sharesError } from '../src/logic.ts'
import { THEMES } from '../src/themes.ts'

type Env = { Variables: { userId: string; userName: string } }
export const api = new Hono<Env>()

const Id = z.string().regex(/^[\w:-]{1,64}$/)
const Kind = z.enum(['trip', 'home', 'couple', 'friends', 'office', 'family'])
const Theme = z.enum(THEMES.map(t => t.id) as [string, ...string[]])
const Upi = z.string().trim().max(256).refine(v => !v || isVpa(v), 'Not a valid UPI ID').nullish()
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Paise = z.number().int().min(0).max(2_000_000_000)

const GroupIn = z.object({ name: z.string().trim().min(1).max(60), kind: Kind, theme: Theme, track: z.boolean().optional(), selfId: Id })
const Email = z.string().trim().toLowerCase().max(254).refine(v => !v || z.email().safeParse(v).success, 'Not a valid email').nullish()
const Phone = z.string().trim().max(20).refine(v => !v || /^\+?[0-9 ()-]{7,20}$/.test(v), 'Not a valid phone number').nullish()
const MemberIn = z.object({ name: z.string().trim().min(1).max(60), upi: Upi, email: Email, phone: Phone })
const APP = process.env.PUBLIC_URL || 'http://localhost:5173'
const claimUrl = (token: string) => `${APP}/#/claim/${token}`
const ExpenseIn = z.object({
  title: z.string().trim().min(1).max(120), cat: z.string().max(20), date: Day, amount: Paise.min(1),
  paid: z.record(Id, Paise), owed: z.record(Id, Paise),
  mode: z.enum(['equal', 'exact', 'percent', 'shares']).nullish(), input: z.record(Id, z.number()).nullish(),
  settle: z.boolean().optional(), repeat: z.object({ next: Day, day: z.number().int().min(1).max(31) }).nullish(),
})
const JoinIn = z.object({ memberId: Id.optional() })

const inviteCode = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const notFound = { error: 'Not found' }

api.use('*', async (c, next) => {
  const s = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!s) return c.json({ error: 'Sign in first' }, 401)
  c.set('userId', s.user.id)
  c.set('userName', s.user.name)
  await next()
})

api.onError((e, c) => {
  if (e instanceof z.ZodError) return c.json({ error: e.issues[0]?.message ?? 'Invalid input' }, 400)
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return c.json({ error: 'Already exists' }, 409)
  console.error(e)
  return c.json({ error: 'Something went wrong' }, 500)
})

/** The caller's membership in a group, or null. Every group route goes through this. */
const membership = (groupId: string, userId: string) => db.member.findFirst({ where: { groupId, userId } })

api.get('/groups', async c => {
  const groups = await db.group.findMany({
    where: { members: { some: { userId: c.get('userId') } } },
    include: { members: { orderBy: { createdAt: 'asc' }, omit: { inviteToken: true } }, expenses: { include: { shares: true }, orderBy: { createdAt: 'asc' } } },
    orderBy: { createdAt: 'desc' },
  })
  return c.json(groups)
})

api.put('/groups/:id', async c => {
  const id = Id.parse(c.req.param('id'))
  const b = GroupIn.parse(await c.req.json())
  const uid = c.get('userId')
  const exists = await db.group.findUnique({ where: { id }, select: { id: true } })
  if (exists) {
    if (!(await membership(id, uid))) return c.json(notFound, 404)
    await db.group.update({ where: { id }, data: { name: b.name, kind: b.kind, theme: b.theme, track: !!b.track } })
  } else {
    await db.group.create({
      data: { id, name: b.name, kind: b.kind, theme: b.theme, track: !!b.track, inviteCode: inviteCode(), createdById: uid,
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
  if (!(await membership(gid, uid))) return c.json(notFound, 404)
  const members = new Set((await db.member.findMany({ where: { groupId: gid }, select: { id: true } })).map(m => m.id))
  const bad = sharesError(b.amount, b.paid, b.owed, members)
  if (bad) return c.json({ error: bad }, 400)
  const existing = await db.expense.findUnique({ where: { id: eid }, select: { groupId: true } })
  if (existing && existing.groupId !== gid) return c.json(notFound, 404)

  const ids = new Set([...Object.keys(b.paid), ...Object.keys(b.owed)])
  const shares = [...ids].map(memberId => ({ memberId, paid: b.paid[memberId] ?? 0, owed: b.owed[memberId] ?? 0 }))
  const data = {
    title: b.title, cat: b.cat, date: b.date, amount: b.amount, mode: b.mode ?? null, input: b.input ?? Prisma.DbNull,
    settle: !!b.settle, repeatNext: b.repeat?.next ?? null, repeatDay: b.repeat?.day ?? null,
  }
  await db.$transaction([
    db.expense.upsert({ where: { id: eid }, create: { id: eid, groupId: gid, createdById: uid, ...data }, update: data }),
    db.expenseShare.deleteMany({ where: { expenseId: eid } }),
    db.expenseShare.createMany({ data: shares.map(s => ({ expenseId: eid, ...s })) }),
  ])
  return c.json({ ok: true })
})

api.delete('/groups/:gid/expenses/:eid', async c => {
  const [gid, eid] = [Id.parse(c.req.param('gid')), Id.parse(c.req.param('eid'))]
  if (!(await membership(gid, c.get('userId')))) return c.json(notFound, 404)
  await db.expense.deleteMany({ where: { id: eid, groupId: gid } })
  return c.json({ ok: true })
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
