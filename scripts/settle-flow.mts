// Settle first, verify after: a payment counts when recorded, the payee verifies or rejects it, proof from the payer.
//   npm run server, then: npx tsx --env-file=.env.development scripts/settle-flow.mts
// Makes throwaway @splittr.test users and a group, and deletes them at the end. (The AI receipt path is server/proof.test.ts.)
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'
import { ProofOut, SavedOut } from '../src/schema.ts'

const API = process.env.RACE_API ?? 'http://localhost:8787'
const run = Date.now()

async function person(name: string) {
  const r = await auth.api.signUpEmail({ body: { name, email: `settle-${name.toLowerCase()}-${run}@splittr.test`, password: 'password123' }, returnHeaders: true })
  await db.user.update({ where: { id: r.response.user.id }, data: { ageGroup: 'adult', emailVerified: true } })
  const token = r.headers.get('set-auth-token')!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
    return { status: res.status, body: await res.json() as any }
  }
  return { name, id: r.response.user.id, call }
}

const [A, B] = await Promise.all([person('Asha'), person('Bala')]) // Asha is paid, Bala pays
const gid = crypto.randomUUID(), a = crypto.randomUUID(), guest = crypto.randomUUID()
const date = new Date().toISOString().slice(0, 10)
const pay = (from: string, to: string, amount: number, o: object = {}) => ({ title: 'Settle up', cat: 'check', date, amount, paid: { [from]: amount }, owed: { [to]: amount }, settle: true, ...o })
const put = (who: typeof A, eid: string, body: object) => who.call('PUT', `/api/groups/${gid}/expenses/${eid}`, body)
const effectOf = async (eid: string, kind: string) => (await db.auditEvent.findFirstOrThrow({ where: { expenseId: eid, kind }, orderBy: { seq: 'desc' } })).effect
try {
  assert.equal((await A.call('PUT', `/api/groups/${gid}`, { name: 'Goa', kind: 'trip', theme: 'classic', selfId: a })).status, 200)
  const code = (await A.call('GET', `/api/groups/${gid}/invite`)).body.code
  assert.equal((await B.call('POST', `/api/invites/${code}/join`, {})).status, 200)
  const b = (await db.member.findFirstOrThrow({ where: { groupId: gid, userId: B.id } })).id
  for (const p of [A, B]) assert.equal((await p.call('POST', '/api/me/push-devices', { platform: 'android', token: `settle-flow-${p.name}-${run}` })).status, 200)

  // Bala pays: it counts at once (the audit moves money), unverified, and Asha is asked now and once more a day later.
  const s1 = crypto.randomUUID()
  let r = await put(B, s1, pay(b, a, 50000, { pending: true, base: null }))
  assert.equal(r.status, 200, JSON.stringify(r.body))
  let saved = SavedOut.parse(r.body)
  assert.deepEqual([saved.pending, saved.verifiedBy ?? null], [true, null])
  assert.deepEqual(await effectOf(s1, 'expense.created'), { [b]: 50000, [a]: -50000 })
  const asks = await db.notification.findMany({ where: { userId: A.id, groupId: gid }, orderBy: { dueAt: 'asc' } })
  assert.deepEqual(asks.map(n => n.kind), ['payment.claimed', 'payment.unverified'])
  assert.ok(Math.abs(asks[1].dueAt.getTime() - Date.now() - 864e5) < 60_000, 'the reminder is due in a day')
  assert.equal((asks[1].data as any).expenseId, s1)
  console.log('✓ a payment counts when recorded; the payee is asked, and reminded a day later')

  // Asha says she got it: verified by the payee, no money moves, Bala hears.
  r = await put(A, s1, pay(b, a, 50000, { pending: false, base: saved.version }))
  saved = SavedOut.parse(r.body)
  assert.deepEqual([saved.pending, saved.verifiedBy], [false, 'payee'])
  const e1 = await db.expense.findUniqueOrThrow({ where: { id: s1 } })
  assert.ok(e1.verifiedAt && e1.verifiedBy === 'payee')
  assert.deepEqual(await effectOf(s1, 'expense.edited'), {})
  assert.equal(await db.notification.count({ where: { userId: B.id, kind: 'payment.confirmed' } }), 1)
  // The same edit again is a no-op that still says how it was verified.
  assert.equal(SavedOut.parse((await put(A, s1, pay(b, a, 50000, { pending: false, base: saved.version }))).body).verifiedBy, 'payee')
  console.log('✓ the payee verifies it')

  // Bala changes the amount: unverified again until Asha says so.
  r = await put(B, s1, pay(b, a, 60000, { base: saved.version }))
  assert.deepEqual([r.body.pending, r.body.verifiedBy], [true, null])
  assert.equal((await db.expense.findUniqueOrThrow({ where: { id: s1 } })).verifiedAt, null)
  console.log('✓ a new amount clears the verification')

  // Asha says another never arrived: it stops counting (the money comes back off), and Bala hears.
  const s2 = crypto.randomUUID()
  await put(B, s2, pay(b, a, 30000, { pending: true, base: null }))
  r = await put(A, s2, pay(b, a, 30000, { rejected: true, base: 1 }))
  assert.deepEqual([r.body.pending, r.body.verifiedBy], [false, null])
  assert.equal((await db.expense.findUniqueOrThrow({ where: { id: s2 } })).rejected, true)
  assert.deepEqual(await effectOf(s2, 'expense.edited'), { [b]: -30000, [a]: 30000 })
  assert.equal(await db.notification.count({ where: { userId: B.id, kind: 'payment.rejected' } }), 1)
  assert.equal((await B.call('POST', `/api/groups/${gid}/expenses/${s2}/proof`, { method: 'upi' })).status, 409, 'no proof on a rejected one')
  console.log('✓ rejected: stops counting, payer told')

  // Asha records Bala's payment herself, and Bala records one to someone not on Plico: both verified at once.
  const s3 = crypto.randomUUID()
  r = await put(A, s3, pay(b, a, 20000, { pending: false, base: null }))
  assert.deepEqual([r.body.pending, r.body.verifiedBy], [false, 'payee'])
  assert.equal((await B.call('PUT', `/api/groups/${gid}/members/${guest}`, { name: 'Dev', phone: '9123456780' })).status, 200)
  r = await put(B, crypto.randomUUID(), pay(b, guest, 10000, { base: null }))
  assert.deepEqual([r.body.pending, r.body.verifiedBy], [false, 'payee'])
  console.log('✓ recorded by the payee, or to a guest: verified at once')

  // Proof: only the payer; cash with a note saves it and verifies nothing.
  const s4 = crypto.randomUUID()
  await put(B, s4, pay(b, a, 40000, { pending: true, base: null }))
  assert.equal((await A.call('POST', `/api/groups/${gid}/expenses/${s4}/proof`, { method: 'cash' })).status, 403)
  r = await B.call('POST', `/api/groups/${gid}/expenses/${s4}/proof`, { method: 'cash', note: 'Handed over at dinner' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  let proof = ProofOut.parse(r.body)
  assert.deepEqual([proof.verifiedBy, proof.pending, proof.version, proof.proof], [null, true, 1, { method: 'cash', note: 'Handed over at dinner' }])
  console.log('✓ proof: payer only; cash and a note')

  // A typed transaction ID: stored, fresh, but on its own it verifies nothing. The same ID on another settlement isn't fresh.
  const s5 = crypto.randomUUID(), s6 = crypto.randomUUID()
  await put(B, s5, pay(b, a, 25000, { pending: true, base: null }))
  await put(B, s6, pay(b, a, 25000, { pending: true, base: null }))
  proof = ProofOut.parse((await B.call('POST', `/api/groups/${gid}/expenses/${s5}/proof`, { method: 'upi', utr: '412345678901' })).body)
  assert.deepEqual([proof.pending, proof.proof.checks], [true, { amount: false, payee: false, time: false, fresh: true }])
  assert.equal((await db.expense.findUniqueOrThrow({ where: { id: s5 } })).utr, '412345678901')
  proof = ProofOut.parse((await B.call('POST', `/api/groups/${gid}/expenses/${s6}/proof`, { method: 'upi', utr: '412345678901' })).body)
  assert.deepEqual([proof.pending, proof.verifiedBy, proof.proof.checks?.fresh], [true, null, false])
  assert.equal((await B.call('POST', `/api/groups/${gid}/expenses/${s6}/proof`, { method: 'upi', utr: '1234' })).status, 400)
  console.log('✓ a transaction ID can’t prove two settlements')

  // Every phone pulls how it was verified and the proof.
  const pulled = (await A.call('GET', '/api/groups')).body.groups.find((g: any) => g.id === gid).expenses
  const byId = (id: string) => pulled.find((e: any) => e.id === id)
  assert.equal(byId(s3).verifiedBy, 'payee')
  assert.deepEqual(byId(s4).proof, { method: 'cash', note: 'Handed over at dinner' })
  assert.equal(byId(s5).utr, '412345678901')
  console.log('✓ the pull carries verifiedBy, proof and utr')

  // The day-later reminder is dropped by the worker when its payment is gone by then (here: deleted, then made due now).
  assert.equal((await B.call('DELETE', `/api/groups/${gid}/expenses/${s6}`)).status, 200)
  const nag = await db.notification.findFirstOrThrow({ where: { userId: A.id, kind: 'payment.unverified', data: { path: ['expenseId'], equals: s6 } } })
  await db.notification.update({ where: { id: nag.id }, data: { dueAt: new Date() } })
  let skipped: string | null = null
  for (let i = 0; i < 20 && !skipped; i++) {
    await new Promise(f => setTimeout(f, 2000))
    skipped = (await db.notification.findUniqueOrThrow({ where: { id: nag.id } })).skipped
  }
  if (skipped) { assert.equal(skipped, 'stale'); console.log('✓ the reminder for a deleted payment is dropped') }
  else console.log('· the push worker didn’t run within 40 s (PUSH_WORKER off?); reminder drop not checked')

  console.log('\nall settle checks passed')
} finally {
  await db.notification.deleteMany({ where: { userId: { in: [A.id, B.id] } } })
  await db.group.deleteMany({ where: { id: gid } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } })
  await db.$disconnect()
}
