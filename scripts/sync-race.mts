// Sync v2 race test: three phones against the dev API (`npm run server` first).
//   npx tsx --env-file=.env scripts/sync-race.mts
// Makes throwaway @splittr.test users and a group, and deletes them at the end.
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'
import { createHash } from 'node:crypto'
import { auditPayload, GENESIS } from '../src/logic.ts'

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
  assert.equal((await B.call('PUT', path, exp('Dinner at Toit', 120000, 2))).body.version, 3, 'keep mine: re-sent on their version')
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
  const all = (await A.call('GET', '/api/groups')).body.groups.find((g: { id: string }) => g.id === gid).expenses
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
  assert.deepEqual(h.slice(0, 9).map((e: any) => `${e.version}:${e.kind}:${e.byName}`),
    ['1:expense.created:Asha', '2:expense.edited:Asha', '3:expense.edited:Bala', '4:expense.deleted:Asha', '5:expense.restored:Bala', '6:expense.edited:Bala', '7:expense.edited:Asha', '8:expense.deleted:Asha', '9:expense.restored:Chitra'])
  assert.equal(h[1].before.amount, 120000); assert.equal(h[1].after.amount, 150000)
  console.log('✓ history: every version with who and what')

  // (h) the audit chain survived all of that concurrency: no gaps, every hash checks, every entry's effect sums to 0,
  // and replaying the effects gives exactly today's balances
  const { head, events } = (await B.call('GET', `/api/groups/${gid}/audit`)).body
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
  const spot = crypto.randomUUID()
  await A.call('PUT', `/api/groups/${g2}/members/${spot}`, { name: 'Esha', email: `esha-${run}@splittr.test` })
  const tok = (await db.member.findUniqueOrThrow({ where: { id: spot } })).inviteToken!
  const cl = await (await fetch(`${API}/api/public/claim/${tok}`)).json() as any
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
  assert.ok(act.events.length > 0 && act.unread > 0)
  assert.ok(act.events.every((e: any) => e.group && typeof e.myEffect === 'number'))
  const money = (await C.call('GET', '/api/me/activity?scope=money')).body
  assert.ok(money.events.every((e: any) => e.myEffect !== 0))
  await C.call('POST', '/api/me/activity/seen', { at: new Date().toISOString() })
  assert.equal((await C.call('GET', '/api/me/activity')).body.unread, 0)
  await C.call('POST', '/api/me/activity/seen', { at: '2020-01-01T00:00:00.000Z' })
  assert.equal((await C.call('GET', '/api/me/activity')).body.unread, 0, 'seen never moves backwards')
  await db.group.deleteMany({ where: { id: g2 } })
  console.log('✓ activity: feed, money filter, unread badge, seen')

  console.log('\nall sync race checks passed')
} finally {
  await db.group.deleteMany({ where: { id: gid } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } })
  await db.$disconnect()
}
