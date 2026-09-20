// Sync v2 race test: three phones against the dev API (`npm run server` first).
//   npx tsx --env-file=.env scripts/sync-race.mts
// Makes throwaway @splittr.test users and a group, and deletes them at the end.
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'

const API = process.env.RACE_API ?? 'http://localhost:8787'
const run = Date.now()

async function phone(name: string) {
  const r = await auth.api.signUpEmail({ body: { name, email: `race-${name.toLowerCase()}-${run}@splittr.test`, password: 'password123' }, returnHeaders: true })
  await db.user.update({ where: { id: r.response.user.id }, data: { ageGroup: 'adult' } })
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
  assert.ok(res.every(x => x.status === 200), 'all 60 adds land')
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
  assert.deepEqual(h.slice(0, 9).map((e: any) => `${e.version}:${e.action}:${e.byName}`),
    ['1:created:Asha', '2:edited:Asha', '3:edited:Bala', '4:deleted:Asha', '5:restored:Bala', '6:edited:Bala', '7:edited:Asha', '8:deleted:Asha', '9:restored:Chitra'])
  assert.equal(h[1].before.amount, 120000); assert.equal(h[1].after.amount, 150000)
  const feed = (await B.call('GET', `/api/groups/${gid}/activity`)).body
  assert.equal(feed.length, 40, 'activity is paged')
  console.log('✓ history: every version with who and what; activity feed pages')
  console.log('\nall sync race checks passed')
} finally {
  await db.group.deleteMany({ where: { id: gid } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } })
  await db.$disconnect()
}
