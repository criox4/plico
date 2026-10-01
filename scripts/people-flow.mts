// People without email: spots and friends by phone, personal friend links, and spots claimed by a verified number.
//   npm run server, then: npx tsx --env-file=.env.development scripts/people-flow.mts
// Makes throwaway @splittr.test users and groups, and deletes them at the end.
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'
import { linkByPhone } from '../server/audit.ts'

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
const gid = crypto.randomUUID(), self = crypto.randomUUID(), spot = crypto.randomUUID()
const groups = () => db.group.findMany({ where: { members: { some: { userId: { in: [A.id, B.id, C.id] } } } }, select: { id: true } })
try {
  assert.equal((await A.call('PUT', `/api/groups/${gid}`, { name: 'Goa', kind: 'trip', theme: 'classic', selfId: self })).status, 200)

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

  // Phase 2: a verified number joins by the group link into the spot added under it, and links spots elsewhere.
  await db.user.update({ where: { id: C.id }, data: { verifiedPhone: '+919000000001', phoneVerifiedAt: new Date() } })
  const cSpot = crypto.randomUUID()
  assert.equal((await A.call('PUT', `/api/groups/${gid}/members/${cSpot}`, { name: 'Chitra', phone: '9000000001' })).status, 200)
  const invite = (await A.call('GET', `/api/groups/${gid}/invite`)).body.code
  assert.equal((await C.call('POST', `/api/invites/${invite}/join`, {})).status, 200)
  assert.equal((await db.member.findUniqueOrThrow({ where: { id: cSpot } })).userId, C.id, 'joined into the spot with their number')
  assert.equal(await db.member.count({ where: { groupId: gid, userId: C.id } }), 1)
  const g2 = crypto.randomUUID(), s2 = crypto.randomUUID(), c2 = crypto.randomUUID()
  await A.call('PUT', `/api/groups/${g2}`, { name: 'Flat', kind: 'home', theme: 'classic', selfId: s2 })
  await A.call('PUT', `/api/groups/${g2}/members/${c2}`, { name: 'Chitra', phone: '+919000000001' })
  assert.equal(await linkByPhone(C.id, '+919000000001'), 1)
  assert.equal((await db.member.findUniqueOrThrow({ where: { id: c2 } })).userId, C.id)
  r = await C.call('GET', '/api/me/phone')
  assert.equal(r.status, 200); assert.equal(r.body.phone, '+919000000001')
  console.log('✓ verified number links spots')

  console.log('\nall people checks passed')
} finally {
  await db.group.deleteMany({ where: { id: { in: (await groups()).map(g => g.id) } } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } })
  await db.$disconnect()
}
