// Sync v2 race test: three phones against the dev API (`npm run server` first).
//   npx tsx --env-file=.env scripts/sync-race.mts
// Makes throwaway @splittr.test users and a group, and deletes them at the end.
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'
import { createHash } from 'node:crypto'
import { auditPayload, GENESIS } from '../src/logic.ts'
import * as z from 'zod/mini'
import { ActivityOut, AuditEvent, AuditOut, ClaimPreviewOut, ConflictOut, GroupsOut, InvitePreviewOut, NotifyOut, RemindLimitOut, RemindOut, SavedOut } from '../src/schema.ts'
import { flush, nudge } from '../server/push.ts'
import { quietUntil } from '../server/push-text.ts'
/** The server's answers must match the shared contract the app reads them with. */
const contract = (schema: z.ZodMiniType, body: unknown, what: string) => {
  const r = schema.safeParse(body)
  assert.ok(r.success, `${what} breaks the contract: ${JSON.stringify(r.error?.issues.slice(0, 3))}`)
}

const API = process.env.RACE_API ?? 'http://localhost:8787'
const run = Date.now()

async function phone(name: string) {
  const r = await auth.api.signUpEmail({ body: { name, email: `race-${name.toLowerCase()}-${run}@splittr.test`, password: 'password123' }, returnHeaders: true })
  await db.user.update({ where: { id: r.response.user.id }, data: { ageGroup: 'adult', emailVerified: true } })
  const token = r.headers.get('set-auth-token')!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  return { name, id: r.response.user.id, call }
}

const [A, B, C] = await Promise.all([phone('Asha'), phone('Bala'), phone('Chitra')])
const gid = crypto.randomUUID(), selfA = crypto.randomUUID()
try {
  assert.equal((await A.call('PUT', `/api/groups/${gid}`, { name: 'Race', kind: 'friends', theme: 'classic', selfId: selfA })).status, 200)
  const code = (await A.call('GET', `/api/groups/${gid}/invite`)).body.code
  await B.call('POST', `/api/invites/${code}/join`, {}); await C.call('POST', `/api/invites/${code}/join`, {})
  const mid = async (u: string) => (await db.member.findFirst({ where: { groupId: gid, userId: u } }))?.id
  const [mB, mC] = [await mid(B.id), await mid(C.id)]
  assert.ok(mB && mC, 'B and C joined')
  const split = (amount: number, payer = selfA, people = [selfA, mB, mC]) => {
    const owed: Record<string, number> = {}
    people.forEach((p, i) => (owed[p] = Math.floor(amount / people.length) + (i < amount % people.length ? 1 : 0)))
    return { paid: { [payer]: amount }, owed }
  }
  const exp = (title: string, amount: number, base: number | null, extra = {}) => ({ title, cat: 'food', date: '2026-09-27', amount, ...split(amount), base, ...extra })
  const eid = crypto.randomUUID(), path = `/api/groups/${gid}/expenses/${eid}`
  const cursor = (await A.call('GET', '/api/groups')).body.now

  // (a) two phones edit the same expense offline from version 1
  assert.equal((await A.call('PUT', path, exp('Dinner', 120000, null))).body.version, 1)
  assert.equal((await A.call('PUT', path, exp('Dinner', 150000, 1))).body.version, 2, 'first edit lands')
  let r = await B.call('PUT', path, exp('Dinner at Toit', 120000, 1))
  assert.equal(r.status, 409, 'second edit from the same base is a conflict')
  assert.equal(r.body.code, 'conflict'); assert.equal(r.body.theirs.amount, 150000); assert.equal(r.body.by, 'Asha')
  contract(ConflictOut, r.body, '409 conflict')
  const kept = (await B.call('PUT', path, exp('Dinner at Toit', 120000, 2))).body
  assert.equal(kept.version, 3, 'keep mine: re-sent on their version'); contract(SavedOut, kept, 'expense PUT')
  console.log('✓ edit vs edit: 409 with their version and name; keep-mine lands')

  // (b) edit vs delete, both orders
  assert.equal((await A.call('DELETE', `${path}?base=3`)).body.version, 4)
  r = await B.call('PUT', path, exp('Dinner at Toit', 99900, 3))
  assert.equal(r.status, 409); assert.ok(r.body.theirs.deletedAt, 'conflict says it was deleted')
  assert.equal((await B.call('PUT', path, exp('Dinner at Toit', 99900, 4))).body.version, 5, 'put it back with my changes')
  assert.equal((await B.call('PUT', path, exp('Dinner at Toit', 88800, 5))).body.version, 6)
  assert.equal((await A.call('DELETE', `${path}?base=5`)).status, 409, 'delete of something changed since is a conflict')
  assert.equal((await A.call('PUT', path, exp('Dinner', 1, undefined as never))).status, 200, 'a pre-versioning client still writes (last write wins)')
  assert.equal((await A.call('DELETE', `${path}?base=7`)).body.version, 8)
  assert.equal((await A.call('DELETE', `${path}?base=8`)).status, 200, 'deleting twice is fine')
  r = await B.call('PUT', path, { ...exp('Dinner', 5000, null), base: undefined })
  assert.equal(r.status, 409, 'a pre-versioning client cannot resurrect a deleted expense')
  assert.equal((await C.call('POST', `${path}/restore`)).body.version, 9, 'restore')
  console.log('✓ edit vs delete (both orders), restore, idempotent delete, legacy clients')

  // (c) a retry after a lost response is not a conflict
  const cur = exp('Dinner', 1, 8)
  r = await A.call('PUT', path, cur)
  assert.equal(r.status, 200); assert.equal(r.body.version, 9, 'same content as current: no new version')
  console.log('✓ lost-response retry: 200, same version')

  // (d) three phones add 20 expenses each at the same time; then 10 rounds of B and C racing on one expense
  const adds = [A, B, C].flatMap(p => Array.from({ length: 20 }, (_, i) => p.call('PUT', `/api/groups/${gid}/expenses/${crypto.randomUUID()}`, exp(`${p.name} ${i}`, 300 + i, null))))
  const res = await Promise.all(adds)
  const badAdds = res.filter(x => x.status !== 200); if (badAdds.length) console.log(badAdds.length, JSON.stringify(badAdds.slice(0, 2)))
  assert.ok(!badAdds.length, 'all 60 adds land')
  let wins = 0
  for (let i = 0; i < 10; i++) {
    const v = (await A.call('GET', `${path}/history`)).body.at(-1).version
    const [x, y] = await Promise.all([B.call('PUT', path, exp(`B${i}`, 1000 + i, v)), C.call('PUT', path, exp(`C${i}`, 2000 + i, v))])
    assert.equal([x.status, y.status].filter(s => s === 200).length, 1, `round ${i}: exactly one wins`)
    assert.equal([x.status, y.status].filter(s => s === 409).length, 1, `round ${i}: the other gets a conflict`)
    wins++
  }
  const full = (await A.call('GET', '/api/groups')).body
  contract(GroupsOut, full, 'GET /groups')
  const all = full.groups.find((g: { id: string }) => g.id === gid).expenses
  assert.equal(all.length, 61)
  const total = all.reduce((s: number, e: any) => s + e.amount, 0)
  const owed = all.flatMap((e: any) => e.shares).reduce((s: number, x: any) => s + x.owed, 0)
  assert.equal(owed, total, 'balances add up')
  console.log(`✓ 60 concurrent adds all land; ${wins}/10 simultaneous edits: exactly one wins, one conflicts`)

  // (e) two phones make the same monthly repeat at once
  const rid = `${eid}:2026-10-01`
  const rep = await Promise.all([A, B].map(p => p.call('PUT', `/api/groups/${gid}/expenses/${rid}`, exp('Rent', 3000000, null))))
  assert.deepEqual(rep.map(x => x.status), [200, 200], 'identical repeat from two phones: both fine, one row')
  console.log('✓ same recurring copy from two phones: one row, no conflict')

  // (f) delta pull: changes and tombstones since the cursor; unknown groups in full
  const gone = crypto.randomUUID()
  await C.call('PUT', `/api/groups/${gid}/expenses/${gone}`, exp('Oops', 100, null))
  await C.call('DELETE', `/api/groups/${gid}/expenses/${gone}?base=1`)
  const d = (await B.call('GET', `/api/groups?since=${encodeURIComponent(cursor)}&known=${gid}`)).body
  contract(GroupsOut, d, 'GET /groups delta')
  const g = d.groups.find((x: { id: string }) => x.id === gid)
  assert.equal(g.full, false)
  assert.ok(g.expenses.some((e: any) => e.id === gone && e.deletedAt), 'tombstone included')
  await new Promise(r => setTimeout(r, 11_000)) // past the 10 s overlap window
  const quiet = (await B.call('GET', '/api/groups')).body.now
  const later = (await B.call('GET', `/api/groups?since=${encodeURIComponent(quiet)}&known=${gid}`)).body.groups[0]
  assert.equal(later.expenses.length, 0, 'nothing changed since the cursor: nothing sent')
  assert.equal((await B.call('GET', `/api/groups?since=${encodeURIComponent(d.now)}&known=`)).body.groups[0].full, true, 'unknown group comes in full')
  console.log('✓ delta pull: changes + tombstones; unknown groups in full')

  // (g) history tells who did what
  const h = (await C.call('GET', `${path}/history`)).body
  contract(z.array(AuditEvent), h, 'expense history')
  assert.deepEqual(h.slice(0, 9).map((e: any) => `${e.version}:${e.kind}:${e.byName}`),
    ['1:expense.created:Asha', '2:expense.edited:Asha', '3:expense.edited:Bala', '4:expense.deleted:Asha', '5:expense.restored:Bala', '6:expense.edited:Bala', '7:expense.edited:Asha', '8:expense.deleted:Asha', '9:expense.restored:Chitra'])
  assert.equal(h[1].before.amount, 120000); assert.equal(h[1].after.amount, 150000)
  console.log('✓ history: every version with who and what')

  // (h) the audit chain survived all of that concurrency: no gaps, every hash checks, every entry's effect sums to 0,
  // and replaying the effects gives exactly today's balances
  const auditBody = (await B.call('GET', `/api/groups/${gid}/audit`)).body
  contract(AuditOut, auditBody, 'group audit')
  const { head, events } = auditBody
  let prev = GENESIS
  events.forEach((e: any, i: number) => {
    assert.equal(e.seq, i + 1, 'no gaps'); assert.equal(e.prevHash, prev, `entry ${e.seq} links to the one before`)
    assert.equal(createHash('sha256').update(prev + auditPayload({ ...e, at: new Date(e.at).toISOString() })).digest('hex'), e.hash, `entry ${e.seq} hash checks`)
    assert.equal(Object.values(e.effect as Record<string, number>).reduce((a, b) => a + b, 0), 0, `entry ${e.seq} effects sum to 0`)
    prev = e.hash
  })
  assert.equal(head.auditHash, prev); assert.equal(head.auditSeq, events.length)
  const replay: Record<string, number> = {}
  for (const e of events) for (const [k, v] of Object.entries(e.effect as Record<string, number>)) replay[k] = (replay[k] ?? 0) + v
  const live = (await A.call('GET', '/api/groups')).body.groups.find((g: { id: string }) => g.id === gid).expenses
  const bal: Record<string, number> = {}
  for (const e of live) if (!e.pending && !e.rejected) for (const x of e.shares) bal[x.memberId] = (bal[x.memberId] ?? 0) + x.paid - x.owed
  for (const k of new Set([...Object.keys(bal), ...Object.keys(replay)])) assert.equal(replay[k] ?? 0, bal[k] ?? 0, `replayed balance for ${k}`)
  console.log(`✓ audit: ${events.length} entries, chain unbroken, effects balance, replay = live balances`)

  // (i) tampering shows: change one old amount and the chain breaks there
  const victim = events[5]
  await db.auditEvent.update({ where: { groupId_seq: { groupId: gid, seq: victim.seq } }, data: { effect: { [selfA]: 1 } } })
  const t = (await B.call('GET', `/api/groups/${gid}/audit`)).body.events[5]
  assert.notEqual(createHash('sha256').update(t.prevHash + auditPayload({ ...t, at: new Date(t.at).toISOString() })).digest('hex'), t.hash)
  console.log('✓ a rewritten entry no longer matches its hash')

  // (j) people: no email, no spot; no duplicates; group links join as yourself
  assert.equal((await A.call('PUT', `/api/groups/${gid}/members/${crypto.randomUUID()}`, { name: 'Nameless' })).status, 400, 'email required')
  const bad = await A.call('PUT', `/api/groups/${gid}/expenses/${crypto.randomUUID()}`, { title: '  ', cat: 'food', date: 'yesterday', amount: -5, paid: {}, owed: {} })
  assert.equal(bad.status, 400); assert.equal(typeof bad.body.error, 'string', 'schema errors come back as a message')
  const ghost = crypto.randomUUID()
  assert.equal((await A.call('PUT', `/api/groups/${gid}/members/${ghost}`, { name: 'Dev', email: `dev-${run}@splittr.test` })).status, 200)
  assert.equal((await A.call('PUT', `/api/groups/${gid}/members/${crypto.randomUUID()}`, { name: 'Dev again', email: `DEV-${run}@splittr.test` })).status, 409, 'same email twice')
  assert.equal((await A.call('PUT', `/api/groups/${gid}/members/${crypto.randomUUID()}`, { name: 'Bala 2', email: `race-bala-${run}@splittr.test` })).status, 409, 'a member’s account email counts too')
  const kinds = (await B.call('GET', `/api/groups/${gid}/audit`)).body.events.map((e: any) => e.kind)
  assert.ok(kinds.includes('member.invited') && kinds.filter((k: string) => k === 'member.joined').length === 2)
  console.log('✓ people: email required, no duplicates, joins and invites on the record')

  // (k) friends: one two-person group per pair, whoever adds whom; no third person
  const f1 = (await A.call('POST', '/api/friends', { email: `race-chitra-${run}@splittr.test`, name: 'Chitra' })).body.id
  const f2 = (await C.call('POST', '/api/friends', { email: `RACE-asha-${run}@splittr.test`, name: 'Asha' })).body.id
  assert.ok(f1 && f1 === f2, 'same friends group from both sides')
  const fg = (await C.call('GET', '/api/groups')).body.groups.find((g: { id: string }) => g.id === f1)
  assert.equal(fg.kind, 'direct'); assert.equal(fg.members.filter((m: any) => m.userId).length, 2, 'Chitra already had an account: linked at once')
  assert.equal((await A.call('PUT', `/api/groups/${f1}/members/${crypto.randomUUID()}`, { name: 'X', email: `x-${run}@splittr.test` })).status, 400, 'no third person')
  assert.equal((await A.call('DELETE', `/api/groups/${f1}`)).status, 403)
  assert.equal((await A.call('POST', '/api/friends', { email: `race-asha-${run}@splittr.test`, name: 'Me' })).status, 400, 'not yourself')
  await db.group.deleteMany({ where: { id: f1 } })
  console.log('✓ friends: one balance per pair from either side, two people only')

  // (l) invite previews before sign-in: the group and who invited you, nothing else
  const g2 = crypto.randomUUID(), selfA2 = crypto.randomUUID()
  await A.call('PUT', `/api/groups/${g2}`, { name: 'Leave test', kind: 'friends', theme: 'classic', selfId: selfA2 })
  const code2 = (await A.call('GET', `/api/groups/${g2}/invite`)).body.code
  const peek = await (await fetch(`${API}/api/public/invites/${code2}`)).json() as any
  assert.deepEqual(peek, { group: { name: 'Leave test', kind: 'friends', theme: 'classic', people: 1 }, invitedBy: 'Asha' })
  contract(InvitePreviewOut, peek, 'invite preview')
  const spot = crypto.randomUUID()
  await A.call('PUT', `/api/groups/${g2}/members/${spot}`, { name: 'Esha', email: `esha-${run}@splittr.test` })
  const tok = (await db.member.findUniqueOrThrow({ where: { id: spot } })).inviteToken!
  const cl = await (await fetch(`${API}/api/public/claim/${tok}`)).json() as any
  contract(ClaimPreviewOut, cl, 'claim preview')
  assert.equal(cl.name, 'Esha'); assert.equal(cl.prefill, `esha-${run}@splittr.test`); assert.equal(cl.invitedBy, 'Asha'); assert.match(cl.email, /^es\*\*\*@/)
  assert.equal((await fetch(`${API}/api/public/claim/${'0'.repeat(32)}`)).status, 404)
  console.log('✓ invite previews: group and inviter only; personal invites pre-fill their email')

  // (m) leaving: only when settled; your spot stays as your email; the maker can't leave an otherwise empty group
  await B.call('POST', `/api/invites/${code2}/join`, {})
  const bSpot = (await db.member.findFirstOrThrow({ where: { groupId: g2, userId: B.id } })).id
  const halves = { [selfA2]: 5000, [bSpot]: 5000 }
  await A.call('PUT', `/api/groups/${g2}/expenses/${crypto.randomUUID()}`, { title: 'Chai', cat: 'food', date: '2026-09-27', amount: 10000, paid: { [selfA2]: 10000 }, owed: halves, base: null })
  const stuck = await B.call('POST', `/api/groups/${g2}/leave`)
  assert.equal(stuck.status, 409); assert.equal(stuck.body.balance, -5000)
  await B.call('PUT', `/api/groups/${g2}/expenses/${crypto.randomUUID()}`, { title: 'Settlement', cat: 'check', date: '2026-09-27', amount: 5000, paid: { [bSpot]: 5000 }, owed: { [selfA2]: 5000 }, settle: true, base: null })
  // B's settlement to A waits for A to confirm; A confirms it
  const pend = (await A.call('GET', '/api/groups')).body.groups.find((g: any) => g.id === g2).expenses.find((e: any) => e.settle)
  await A.call('PUT', `/api/groups/${g2}/expenses/${pend.id}`, { title: 'Settlement', cat: 'check', date: '2026-09-27', amount: 5000, paid: { [bSpot]: 5000 }, owed: { [selfA2]: 5000 }, settle: true, pending: false, base: pend.version })
  assert.equal((await B.call('POST', `/api/groups/${g2}/leave`)).status, 200, 'settled: can leave')
  const left = await db.member.findUniqueOrThrow({ where: { id: bSpot } })
  assert.equal(left.userId, null); assert.equal(left.email, `race-bala-${run}@splittr.test`)
  assert.ok(!(await B.call('GET', '/api/groups')).body.groups.some((g: any) => g.id === g2), 'gone from B’s list')
  assert.equal((await A.call('POST', `/api/groups/${g2}/leave`)).status, 409, 'the maker, alone on Plico, deletes instead')
  const kinds2 = (await A.call('GET', `/api/groups/${g2}/audit`)).body.events.map((e: any) => e.kind)
  assert.ok(kinds2.includes('member.left'))
  console.log('✓ leave: only when settled, history intact, logged')

  // (n) activity: everything in my groups, an unread count of other people's entries, cleared everywhere by "seen"
  const act = (await C.call('GET', '/api/me/activity')).body
  contract(ActivityOut, act, 'activity')
  assert.ok(act.events.length > 0 && act.unread > 0)
  assert.ok(act.events.every((e: any) => e.group && typeof e.myEffect === 'number'))
  const money = (await C.call('GET', '/api/me/activity?scope=money')).body
  contract(ActivityOut, money, 'activity (money)')
  assert.ok(money.events.every((e: any) => e.myEffect !== 0))
  await C.call('POST', '/api/me/activity/seen', { at: new Date().toISOString() })
  assert.equal((await C.call('GET', '/api/me/activity')).body.unread, 0)
  await C.call('POST', '/api/me/activity/seen', { at: '2020-01-01T00:00:00.000Z' })
  assert.equal((await C.call('GET', '/api/me/activity')).body.unread, 0, 'seen never moves backwards')
  await db.group.deleteMany({ where: { id: g2 } })
  console.log('✓ activity: feed, money filter, unread badge, seen')

  // (o) push: devices, the outbox, batching, quiet hours, preferences, the daily cap, Remind limits, sign-out
  const endpoint = (who: string) => `https://fcm.googleapis.com/fcm/send/race-${who}-${run}`
  const keys = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' }
  assert.equal((await B.call('POST', '/api/me/push-devices', { platform: 'web', token: 'http://localhost:1/evil', keys })).status, 400, 'only real push services')
  for (const [u, who] of [[A, 'a'], [B, 'b']] as const) assert.equal((await u.call('POST', '/api/me/push-devices', { platform: 'web', token: endpoint(who), keys, tz: 'Asia/Kolkata' })).status, 200)
  const nb = (await B.call('GET', '/api/me/notify')).body
  contract(NotifyOut, nb, 'notify'); assert.equal(nb.sessions.length, 1); assert.equal(nb.prefs.nudge, true)

  const g3 = crypto.randomUUID(), selfA3 = crypto.randomUUID()
  await A.call('PUT', `/api/groups/${g3}`, { name: 'Push', kind: 'friends', theme: 'classic', selfId: selfA3 })
  const code3 = (await A.call('GET', `/api/groups/${g3}/invite`)).body.code
  await B.call('POST', `/api/invites/${code3}/join`, {}); await C.call('POST', `/api/invites/${code3}/join`, {})
  const [b3, c3] = [await db.member.findFirstOrThrow({ where: { groupId: g3, userId: B.id } }), await db.member.findFirstOrThrow({ where: { groupId: g3, userId: C.id } })]
  const rows = (u: string, kind?: string) => db.notification.findMany({ where: { userId: u, groupId: g3, ...(kind && { kind }) }, orderBy: { createdAt: 'asc' } })
  assert.deepEqual((await rows(A.id)).map(r => r.kind), ['member.joined', 'member.joined'], 'A hears about the joins; C has no device, so no rows')
  assert.equal((await db.notification.count({ where: { userId: C.id } })), 0)
  await db.notification.deleteMany({ where: { groupId: g3 } })
  const third = (amount: number) => ({ [selfA3]: amount / 4, [b3.id]: amount / 2, [c3.id]: amount / 4 })
  const spend = (title: string, amount: number) => A.call('PUT', `/api/groups/${g3}/expenses/${crypto.randomUUID()}`, { title, cat: 'food', date: '2026-09-27', amount, paid: { [selfA3]: amount }, owed: third(amount), base: null })
  await spend('Chai', 40000); await spend('Samosa', 20000)
  let bRows = await rows(B.id)
  assert.deepEqual(bRows.map(r => [r.kind, (r.data as any).share]), [['expense.created', 20000], ['expense.created', 10000]], 'one row each, with B’s share')
  assert.ok(bRows.every(r => r.dueAt.getTime() > Date.now() + 60_000), 'batched: due in ~2 minutes')
  assert.equal((await rows(A.id)).length, 0, 'never the person who made the change')
  // The first row falls due: the whole batch goes as one push.
  await db.notification.update({ where: { id: bRows[0].id }, data: { dueAt: new Date() } })
  const settled = async (ids: string[]) => { for (let i = 0; i < 40; i++) { const x = await db.notification.findMany({ where: { id: { in: ids } } }); if (x.every(r => r.sentAt && r.skipped !== undefined) && x.filter(r => r.skipped === null || r.skipped === 'merged').length === x.length) return x; await flush(); await new Promise(r => setTimeout(r, 250)) } return db.notification.findMany({ where: { id: { in: ids } } }) }
  bRows = await settled(bRows.map(r => r.id))
  assert.deepEqual(bRows.map(r => r.skipped).sort(), ['merged', null].sort() as any, 'one sent, one merged into it')

  // Quiet hours hold pushes until 08:00 local; switched-off kinds are dropped; the daily cap stops the ninth.
  const night = [...Array(27)].map((_, i) => `Etc/GMT${i - 12 < 0 ? '+' : '-'}${Math.abs(i - 12)}`).find(z => { try { return !!quietUntil(z) } catch { return false } })!
  await db.user.update({ where: { id: B.id }, data: { tz: night } })
  await spend('Late chai', 8000)
  const late = (await rows(B.id)).at(-1)!
  await db.notification.update({ where: { id: late.id }, data: { dueAt: new Date() } })
  await flush(); await new Promise(r => setTimeout(r, 300))
  const held = await db.notification.findUniqueOrThrow({ where: { id: late.id } })
  assert.equal(held.sentAt, null, 'held for the morning'); assert.ok(held.dueAt.getTime() > Date.now(), 'due when quiet hours end')
  await db.user.update({ where: { id: B.id }, data: { tz: 'Asia/Kolkata' } })
  if (quietUntil('Asia/Kolkata')) await db.user.update({ where: { id: B.id }, data: { notify: { quiet: false } } }) // the test may run at night in India
  await db.notification.deleteMany({ where: { userId: B.id } })

  assert.equal((await B.call('PUT', '/api/me/notify', { activity: false })).body.prefs.activity, false)
  await spend('Muted', 4000)
  const muted = (await rows(B.id)).at(-1)!
  await db.notification.update({ where: { id: muted.id }, data: { dueAt: new Date() } })
  assert.equal((await settled([muted.id]).then(() => db.notification.findUniqueOrThrow({ where: { id: muted.id } }))).skipped, 'off')
  await B.call('PUT', '/api/me/notify', { activity: true })

  await db.notification.createMany({ data: [...Array(8)].map(() => ({ userId: B.id, kind: 'expense.created', groupId: g3, data: {}, sentAt: new Date() })) })
  await spend('Ninth', 4000)
  const ninth = (await rows(B.id)).at(-1)!
  await db.notification.update({ where: { id: ninth.id }, data: { dueAt: new Date() } })
  for (let i = 0; i < 20 && !(await db.notification.findUniqueOrThrow({ where: { id: ninth.id } })).skipped; i++) { await flush(); await new Promise(r => setTimeout(r, 250)) }
  assert.equal((await db.notification.findUniqueOrThrow({ where: { id: ninth.id } })).skipped, 'cap', 'the daily cap')
  console.log('✓ push: devices, outbox per change, batching, quiet hours, preferences, daily cap')

  // Payments skip the batch and the cap: B marks a payment to A, A is told at once.
  await B.call('PUT', `/api/groups/${g3}/expenses/${crypto.randomUUID()}`, { title: 'Settlement', cat: 'check', date: '2026-09-27', amount: 1000, paid: { [b3.id]: 1000 }, owed: { [selfA3]: 1000 }, settle: true, pending: true, base: null })
  const claim = (await rows(A.id, 'payment.claimed'))[0]
  assert.ok(claim && claim.dueAt.getTime() <= Date.now(), 'payment claims are due now')
  assert.equal((claim.data as any).amount, 1000)

  // Remind: needs an account with a device, a debt, and respects once a day per person per group.
  const remind = (u: typeof A, m: string) => u.call('POST', `/api/groups/${g3}/remind`, { memberId: m, amount: 5000 })
  r = await remind(A, b3.id); assert.equal(r.status, 200); contract(RemindOut, r.body, 'remind')
  r = await remind(A, b3.id); assert.equal(r.status, 429); assert.equal(r.body.code, 'limit'); contract(RemindLimitOut, r.body, 'remind limit')
  assert.ok(new Date(r.body.retryAt).getTime() > Date.now() + 23 * 3600e3)
  r = await remind(A, c3.id); assert.equal(r.status, 409); assert.equal(r.body.code, 'no-device')
  r = await remind(B, selfA3); assert.equal(r.status, 409); assert.equal(r.body.code, 'square', 'A owes nobody here')
  console.log('✓ push: payments go now; Remind limited, and only to someone who owes and can get it')

  // Weekly nudge: Sunday 11:00 local, to people with a device who have owed for over a week; once a week.
  await db.notification.deleteMany({ where: { userId: B.id } })
  await db.pushDevice.create({ data: { userId: B.id, sessionId: (await db.session.findFirstOrThrow({ where: { userId: B.id } })).id, platform: 'web', token: endpoint('b2'), keys } })
  await db.expense.updateMany({ where: { groupId: g3 }, data: { createdAt: new Date('2026-09-01') } })
  const sunday11 = new Date(Date.UTC(2026, 8, 27, 5, 30)) // 11:00 in India
  assert.equal(await nudge(new Date(Date.UTC(2026, 8, 26, 5, 30))), 0, 'not on a Saturday')
  await nudge(sunday11)
  const nd = await db.notification.findFirstOrThrow({ where: { userId: B.id, kind: 'nudge' } })
  assert.deepEqual(nd.data, { amount: 20000 + 10000 + 4000 + 2000 + 2000, groups: 1 }, 'what B owes; the payment still waiting to be confirmed doesn’t count yet')
  await nudge(sunday11)
  assert.equal(await db.notification.count({ where: { userId: B.id, kind: 'nudge' } }), 1, 'once a week')
  console.log('✓ push: weekly nudge on Sunday morning, once')

  // Signing out a device's session stops its pushes.
  const sess = (await db.pushDevice.findFirstOrThrow({ where: { userId: B.id } })).sessionId
  await db.session.delete({ where: { id: sess } })
  assert.equal(await db.pushDevice.count({ where: { userId: B.id } }), 0)
  await db.group.deleteMany({ where: { id: g3 } })
  console.log('✓ push: signing out removes the device')

  console.log('\nall sync race checks passed')
} finally {
  await db.group.deleteMany({ where: { id: gid } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } })
  await db.$disconnect()
}
