import { Hono } from 'hono'
import { z } from 'zod'
import { auth } from './auth.ts'
import { db } from './db.ts'
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
const MemberIn = z.object({ name: z.string().trim().min(1).max(60), upi: Upi })
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
    include: { members: { orderBy: { createdAt: 'asc' } }, expenses: { include: { shares: true }, orderBy: { createdAt: 'asc' } } },
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
  const data = { name: b.name, upi: b.upi || null }
  if (m) await db.member.update({ where: { id: mid }, data })
  else await db.member.create({ data: { id: mid, groupId: gid, ...data } })
  return c.json({ ok: true })
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

// ---------- invites: a friend signs in and claims their guest profile ----------
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
