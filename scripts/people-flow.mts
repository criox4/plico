// People without email: spots and friends by phone, personal friend links, and joining by the group link.
//   npm run server, then: npx tsx --env-file=.env.development scripts/people-flow.mts
// Makes throwaway @splittr.test users and groups, and deletes them at the end.
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'

const API = process.env.RACE_API ?? 'http://localhost:8787'
const run = Date.now()

async function person(name: string) {
  const r = await auth.api.signUpEmail({ body: { name, email: `people-${name.toLowerCase()}-${run}@splittr.test`, password: 'password123' }, returnHeaders: true })
  await db.user.update({ where: { id: r.response.user.id }, data: { ageGroup: 'adult', emailVerified: true } })
  const token = r.headers.get('set-auth-token')!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  return { name, id: r.response.user.id, call }
}

const [A, B, C] = await Promise.all([person('Asha'), person('Bala'), person('Chitra')])
const extra: string[] = []
const gid = crypto.randomUUID(), self = crypto.randomUUID(), spot = crypto.randomUUID()
const groups = () => db.group.findMany({ where: { members: { some: { userId: { in: [A.id, B.id, C.id, ...extra] } } } }, select: { id: true } })
try {
  assert.equal((await A.call('PUT', `/api/groups/${gid}`, { name: 'Goa', kind: 'trip', theme: 'classic', selfId: self, create: true })).status, 200)

  // A spot by phone alone, stored in one form; the same number again is refused.
  let r = await A.call('PUT', `/api/groups/${gid}/members/${spot}`, { name: 'Bala', phone: '98765 43210' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal((await db.member.findUniqueOrThrow({ where: { id: spot } })).phone, '+919876543210')
  r = await A.call('PUT', `/api/groups/${gid}/members/${crypto.randomUUID()}`, { name: 'Bala 2', phone: '+91 98765-43210' })
  assert.equal(r.status, 409)
  r = await A.call('PUT', `/api/groups/${gid}/members/${crypto.randomUUID()}`, { name: 'Nobody' })
  assert.equal(r.status, 400)
  console.log('✓ spots by phone')

  // Its personal link goes on WhatsApp; Bala claims it.
  r = await A.call('POST', `/api/groups/${gid}/members/${spot}/invite`, {})
  const token = String(r.body.link).split('/claim/')[1]
  assert.ok(token, JSON.stringify(r.body))
  assert.equal((await B.call('POST', `/api/claim/${token}`, {})).status, 200)
  assert.equal((await db.member.findUniqueOrThrow({ where: { id: spot } })).userId, B.id)
  console.log('✓ phone spot claimed by its link')

  // Friends: by phone (a placeholder with a link), by account, and the same pair found again.
  r = await A.call('POST', '/api/friends', { name: 'Dev', phone: '9123456789' })
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.link)
  const dev = r.body.id
  assert.equal((await A.call('POST', '/api/friends', { name: 'Dev', phone: '+919123456789' })).body.id, dev)
  r = await A.call('POST', '/api/friends', { name: 'Bala', userId: B.id })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const ab = r.body.id
  assert.equal((await A.call('POST', '/api/friends', { name: 'Chitra', userId: C.id })).status, 404, 'only people you share a group with')
  assert.equal((await A.call('POST', '/api/friends', { name: 'X', email: 'x@splittr.test', phone: '9123456789' })).status, 400)
  console.log('✓ friends by phone and by account')

  // A personal link: public card, the pair already exists so it's the same ledger, own link refused, reset retires it.
  const code = (await A.call('GET', '/api/me/friend-code')).body.code
  assert.match(code, /^[a-z0-9]{10}$/)
  assert.equal((await A.call('GET', '/api/me/friend-code')).body.code, code)
  const card = await (await fetch(`${API}/api/public/u/${code}`)).json() as any
  assert.equal(card.name, 'Asha')
  assert.equal((await B.call('POST', `/api/friends/code/${code}`, {})).body.id, ab)
  assert.equal((await A.call('POST', `/api/friends/code/${code}`, {})).status, 400)
  r = await C.call('POST', `/api/friends/code/${code}`, {})
  assert.equal(r.status, 200)
  const ac = await db.group.findUniqueOrThrow({ where: { id: r.body.id }, include: { members: true } })
  assert.deepEqual(ac.members.map(m => m.userId).sort(), [A.id, C.id].sort())
  const fresh = (await A.call('POST', '/api/me/friend-code/reset', {})).body.code
  assert.notEqual(fresh, code)
  assert.equal((await fetch(`${API}/api/public/u/${code}`)).status, 404)
  console.log('✓ personal friend links')

  // Chitra joins Goa by the group link, as herself.
  const invite = (await A.call('GET', `/api/groups/${gid}/invite`)).body.code
  assert.equal((await C.call('POST', `/api/invites/${invite}/join`, {})).status, 200)
  assert.equal(await db.member.count({ where: { groupId: gid, userId: C.id } }), 1)
  console.log('✓ joined by the group link')

  // Like Splitwise: sharing a group makes friends that outlive it. Bala and Chitra share only Goa.
  assert.equal(await db.friendship.count({ where: { OR: [{ userId: B.id, friendId: C.id }, { userId: C.id, friendId: B.id }] } }), 2, 'joining made them friends, both ways')
  assert.equal((await B.call('POST', '/api/friends', { name: 'Chitra', userId: C.id })).status, 200, 'a friend you share a group with')
  await db.group.deleteMany({ where: { kind: 'direct', AND: [{ members: { some: { userId: B.id } } }, { members: { some: { userId: C.id } } }] } })
  assert.equal((await B.call('POST', `/api/groups/${gid}/leave`, {})).status, 200)
  r = await B.call('GET', '/api/groups')
  assert.deepEqual(r.body.friends.map((f: any) => f.id).sort(), [C.id], 'Chitra is still a friend after Bala left Goa (Asha shares a friends ledger with Bala)')
  assert.equal((await B.call('POST', '/api/friends', { name: 'Chitra', userId: C.id })).status, 200, 'and Bala can still split with her directly')
  console.log('✓ friends outlive the group')

  // The group link lists spots still waiting, contacts masked, so the joiner can take theirs.
  await A.call('PUT', `/api/groups/${gid}/members/${crypto.randomUUID()}`, { name: 'Dev', phone: '9123456789' })
  r = await C.call('GET', `/api/invites/${invite}`)
  const dev2 = r.body.spots.find((x: any) => x.name === 'Dev')
  assert.equal(dev2.phone, '•••• 6789')
  assert.ok(!JSON.stringify(r.body.spots).includes('9123456789'), 'never the full number')
  console.log('✓ the group link lists waiting spots, masked')

  // "That's me": a newcomer asks for a phone spot, whoever added it confirms, and the spot, its balance and its number move.
  const [D, E] = await Promise.all([person('Dhruv'), person('Esha')])
  extra.push(D.id, E.id)
  const dSpot = crypto.randomUUID()
  await A.call('PUT', `/api/groups/${gid}/members/${dSpot}`, { name: 'DB', phone: '9876500001' })
  const lunch = crypto.randomUUID()
  assert.equal((await A.call('PUT', `/api/groups/${gid}/expenses/${lunch}`, { title: 'Lunch', cat: 'food', date: '2026-11-01', amount: 20000, paid: { [self]: 20000 }, owed: { [self]: 10000, [dSpot]: 10000 } })).status, 200)
  r = await D.call('GET', `/api/invites/${invite}`)
  const db1 = r.body.spots.find((x: any) => x.id === dSpot)
  assert.equal(db1.confirmBy, 'Asha'); assert.equal(db1.asked, false)
  assert.equal((await D.call('POST', `/api/invites/${invite}/spots/${dSpot}/ask`, {})).status, 200)
  assert.equal((await D.call('GET', `/api/invites/${invite}`)).body.spots.find((x: any) => x.id === dSpot).asked, true, 'the wait survives a reload')
  assert.equal((await E.call('POST', `/api/invites/${invite}/spots/${dSpot}/ask`, {})).status, 409, 'one request per spot')
  assert.equal((await C.call('GET', '/api/me/claims')).body.claims.length, 0, 'only whoever added it sees the request')
  r = await A.call('GET', '/api/me/claims')
  assert.deepEqual(r.body.claims.map((x: any) => [x.id, x.groupId, x.by.name, x.phone]), [[dSpot, gid, 'Dhruv', '+919876500001']])
  assert.equal((await C.call('POST', `/api/groups/${gid}/claims/${dSpot}`, { yes: true })).status, 403)
  assert.equal((await A.call('POST', `/api/groups/${gid}/claims/${dSpot}`, { yes: true })).status, 200)
  assert.equal((await db.member.findUniqueOrThrow({ where: { id: dSpot } })).userId, D.id, 'the spot, and the ₹100 it owes, are Dhruv’s')
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: D.id } })).phone, '+919876500001', 'its number fills in his profile')
  assert.equal(await db.notification.count({ where: { userId: D.id, kind: 'claim.approved' } }), 1)
  console.log('✓ a spot confirmed by whoever added it')

  // Not them: the request clears, and they join as themselves.
  const eSpot = crypto.randomUUID()
  await A.call('PUT', `/api/groups/${gid}/members/${eSpot}`, { name: 'Ekta', phone: '9876500002' })
  assert.equal((await E.call('POST', `/api/invites/${invite}/spots/${eSpot}/ask`, {})).status, 200)
  assert.equal((await A.call('POST', `/api/groups/${gid}/claims/${eSpot}`, { yes: false })).status, 200)
  assert.equal((await db.member.findUniqueOrThrow({ where: { id: eSpot } })).userId, null)
  assert.equal(await db.notification.count({ where: { userId: E.id, kind: 'claim.declined' } }), 1)
  assert.equal((await E.call('POST', `/api/invites/${invite}/join`, {})).status, 200)
  assert.equal((await A.call('GET', '/api/me/claims')).body.claims.length, 0)
  console.log('✓ a request turned down, then joined as themselves')

  console.log('\nall people checks passed')
} finally {
  await db.group.deleteMany({ where: { id: { in: (await groups()).map(g => g.id) } } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id, C.id, ...extra] } } })
  await db.$disconnect()
}
