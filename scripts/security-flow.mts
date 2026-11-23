// The access rules that are easy to break by accident: who gets a waiting person's claim link and contact details,
// what a payer can mark verified, and the limits on names, origins, sign-in tries and request sizes.
//   npm run server, then: npx tsx --env-file=.env.development scripts/security-flow.mts
// Makes throwaway @splittr.test users and a group, and deletes them at the end.
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'

const API = process.env.RACE_API ?? 'http://localhost:8787'
const run = Date.now()
const json = { 'content-type': 'application/json', origin: 'http://localhost:5173' }

async function person(name: string) {
  const email = `sec-${name.toLowerCase()}-${run}@splittr.test`
  const r = await auth.api.signUpEmail({ body: { name, email, password: 'password123' }, returnHeaders: true })
  await db.user.update({ where: { id: r.response.user.id }, data: { ageGroup: 'adult', emailVerified: true } })
  const token = r.headers.get('set-auth-token')!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, ...json }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    const text = await res.text()
    return { status: res.status, text, body: (() => { try { return JSON.parse(text) } catch { return null } })() as any }
  }
  return { name, email, id: r.response.user.id, call }
}

const [A, B, C] = await Promise.all([person('Asha'), person('Bala'), person('Chitra')]) // Asha makes the group and adds the waiting person
const gid = crypto.randomUUID(), a = crypto.randomUUID(), w = crypto.randomUUID()
const waiting = { name: 'Waiting Person', email: `sec-waiting-${run}@splittr.test`, phone: '+919812345678' }
const date = new Date().toISOString().slice(0, 10)
try {
  assert.equal((await A.call('PUT', `/api/groups/${gid}`, { name: 'Security flow', kind: 'trip', theme: 'classic', selfId: a, create: true })).status, 200)
  assert.equal((await A.call('PUT', `/api/groups/${gid}/members/${w}`, waiting)).status, 200)
  const code = (await A.call('GET', `/api/groups/${gid}/invite`)).body.code
  for (const p of [B, C]) assert.equal((await p.call('POST', `/api/invites/${code}/join`, {})).status, 200)
  const mine = (await B.call('GET', '/api/groups')).body.groups.find((g: any) => g.id === gid)
  const b = mine.members.find((m: any) => m.userId === B.id).id

  // The personal claim link hands over the spot: only for whoever added the person.
  assert.match((await A.call('POST', `/api/groups/${gid}/members/${w}/invite`, {})).body.link, /#\/claim\/[a-f0-9]{32}$/)
  assert.equal((await B.call('POST', `/api/groups/${gid}/members/${w}/invite`, {})).body.link, undefined)
  console.log('✓ the claim link goes to whoever added the person, nobody else')

  // Their contact: in full for the adder, masked for everyone else, wherever it shows.
  const spot = mine.members.find((m: any) => m.id === w)
  assert.ok(spot.email.includes('•') && spot.phone.includes('•'), 'group list')
  for (const path of ['/api/me/export', `/api/groups/${gid}/audit`]) {
    const seen = (await B.call('GET', path)).text
    assert.ok(!seen.includes(waiting.email) && !seen.includes(waiting.phone), path)
  }
  assert.ok((await A.call('GET', '/api/me/export')).text.includes(waiting.email))
  console.log('✓ a waiting person’s email and phone stay masked in the group list, the export and the audit log')

  // Their UPI ID decides where "Pay them" goes: only the adder may set it.
  const hijack = await B.call('PUT', `/api/groups/${gid}/members/${w}`, { name: waiting.name, upi: 'bala@okaxis' })
  assert.equal(hijack.status, 403); assert.equal(hijack.body.code, 'not-yours')
  assert.equal((await A.call('PUT', `/api/groups/${gid}/members/${w}`, { ...waiting, upi: 'waiting@okaxis' })).status, 200)
  console.log('✓ only whoever added a waiting person can change their UPI ID')

  // An expense turned into a payment is a new payment: the payee hasn't verified anything.
  const eid = crypto.randomUUID(), exp = { title: 'Lunch', cat: 'food', date, amount: 5000, paid: { [b]: 5000 }, owed: { [a]: 5000 } }
  const made = await B.call('PUT', `/api/groups/${gid}/expenses/${eid}`, { ...exp, base: null })
  const flipped = await B.call('PUT', `/api/groups/${gid}/expenses/${eid}`, { ...exp, title: 'Settlement', settle: true, base: made.body.version })
  assert.equal(flipped.body.pending, true); assert.equal(flipped.body.verifiedBy, null)
  console.log('✓ flipping an expense into a payment doesn’t make it verified')

  // One UPI transaction ID proves one payment.
  const pay = (id: string) => B.call('PUT', `/api/groups/${gid}/expenses/${id}`, { title: 'Settlement', cat: 'check', date, amount: 5000, paid: { [b]: 5000 }, owed: { [a]: 5000 }, settle: true, base: null })
  const [p1, p2] = [crypto.randomUUID(), crypto.randomUUID()]
  await pay(p1); await pay(p2)
  const utr = String(run).slice(-12).padStart(12, '7')
  assert.equal((await B.call('POST', `/api/groups/${gid}/expenses/${p1}/proof`, { method: 'upi', utr })).status, 200)
  const again = await B.call('POST', `/api/groups/${gid}/expenses/${p2}/proof`, { method: 'upi', utr })
  assert.equal(again.status, 200); assert.equal(again.body.proof.checks.fresh, false)
  assert.equal((await db.expense.findUniqueOrThrow({ where: { id: p2 } })).utr, null)
  console.log('✓ a transaction ID already used isn’t accepted as proof of a second payment')

  // Names, origins, request sizes.
  assert.equal((await B.call('POST', '/api/auth/update-user', { name: 'x'.repeat(200) })).status, 400)
  const pre = await fetch(API + '/api/groups', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } })
  assert.equal(pre.headers.get('access-control-allow-origin'), null)
  const t0 = Date.now(), big = await A.call('POST', '/api/chat', { messages: Array(200_000).fill(0), today: date })
  assert.ok([400, 503].includes(big.status) && Date.now() - t0 < 5000, `${big.status} in ${Date.now() - t0} ms`)
  console.log('✓ long names, unknown origins and oversized bodies are refused')

  // Ten wrong passwords stop that address for that account; the count is kept in the database, so a restart doesn't reset it.
  // (One real miss, nine written in: Better Auth's own limit allows three sign-in tries in ten seconds.)
  const tryIn = (password: string) => fetch(API + '/api/auth/sign-in/email', { method: 'POST', headers: json, body: JSON.stringify({ email: C.email, password }) })
  assert.equal((await tryIn('wrong-password')).status, 401)
  const miss = await db.rateHit.findFirstOrThrow({ where: { key: { startsWith: `signin:${C.email}|` } } })
  await db.rateHit.createMany({ data: Array.from({ length: 9 }, () => ({ key: miss.key })) })
  const locked = await tryIn('password123')
  assert.equal(locked.status, 429); assert.equal((await locked.json()).code, 'TOO_MANY_ATTEMPTS')
  console.log('✓ ten wrong passwords lock that address out of the account, counted in the database')

  console.log('\nall security checks passed')
} finally {
  await db.rateHit.deleteMany({ where: { key: { contains: `-${run}@splittr.test` } } })
  await db.rateHit.deleteMany({ where: { key: { in: [A, B, C].flatMap(p => [`upload:${p.id}`, `chat:${p.id}`, `ai-read:${p.id}`]) } } })
  await db.emailLog.deleteMany({ where: { OR: [{ byId: { in: [A.id, B.id, C.id] } }, { to: waiting.email }] } })
  await db.notification.deleteMany({ where: { userId: { in: [A.id, B.id, C.id] } } })
  await db.group.deleteMany({ where: { id: gid } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id, C.id] } } })
  await db.$disconnect()
}
