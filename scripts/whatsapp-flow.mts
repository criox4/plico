// WhatsApp phone verification, end to end without a phone: signed webhook deliveries made here, as Meta would send them.
//   npx tsx --env-file=.env.development scripts/whatsapp-flow.mts                         (local API, `npm run server`)
//   RACE_API=https://api.plico.space npx tsx --env-file=.env.production scripts/whatsapp-flow.mts   (live)
// The env file must hold the same WA_APP_SECRET as the API under test. Uses fictional +1 555 01xx numbers, so replies
// the API tries to send go nowhere. Makes throwaway @splittr.test users and deletes them at the end.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'

const API = process.env.RACE_API ?? 'http://localhost:8787'
const SECRET = process.env.WA_APP_SECRET!
assert.ok(SECRET, 'WA_APP_SECRET must be in the env file')
const run = Date.now()
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function person(name: string) {
  const r = await auth.api.signUpEmail({ body: { name, email: `wa-${name.toLowerCase()}-${run}@splittr.test`, password: 'password123' }, returnHeaders: true })
  await db.user.update({ where: { id: r.response.user.id }, data: { ageGroup: 'adult', emailVerified: true } })
  const token = r.headers.get('set-auth-token')!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return { status: res.status, body: await res.json() as any }
  }
  return { id: r.response.user.id, call }
}

/** One delivery as Meta sends it, signed with the app secret unless told otherwise. */
async function deliver(from: string, msg: object, { sign = true, at = Date.now() } = {}) {
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '0', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: '0' },
    contacts: [{ profile: { name: 'Test' }, wa_id: from }],
    messages: [{ from, id: `wamid.${crypto.randomUUID()}`, timestamp: String(Math.floor(at / 1000)), ...msg }],
  } }] }] })
  const sig = sign ? 'sha256=' + createHmac('sha256', SECRET).update(raw).digest('hex') : 'sha256=' + '0'.repeat(64)
  const r = await fetch(`${API}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw })
  await wait(1500) // the webhook answers first and works after
  return r.status
}
const text = (body: string) => ({ type: 'text', text: { body } })
const button = (id: string) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } })

const NUM = '15550100001', PHONE = '+15550100001', OTHER = '15550100002'
const [A, B] = await Promise.all([person('Asha'), person('Bala')])
const gid = crypto.randomUUID(), spot = crypto.randomUUID()
try {
  // A spot added under the number before it's verified: verifying links it.
  await B.call('PUT', `/api/groups/${gid}`, { name: 'Goa', kind: 'trip', theme: 'classic', selfId: crypto.randomUUID() })
  assert.equal((await B.call('PUT', `/api/groups/${gid}/members/${spot}`, { name: 'Asha', phone: PHONE })).status, 200)

  let r = await A.call('GET', '/api/me/phone')
  assert.equal(r.body.available, true, 'the API under test has all five WA_* settings')
  assert.equal(r.body.phone, null)
  r = await A.call('POST', '/api/me/phone/start', {})
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const code: string = r.body.code
  assert.match(code, /^[A-HJ-NP-Z2-9]{6}$/)
  assert.ok(r.body.link.startsWith('https://wa.me/') && decodeURIComponent(r.body.link).endsWith(`Verify PLICO-${code}`))
  assert.equal((await A.call('GET', '/api/me/phone')).body.pending, true)
  console.log('✓ start: a code and a WhatsApp link with it')

  assert.equal(await deliver(NUM, text(`Verify PLICO-${code}`), { sign: false }), 401)
  assert.equal(await deliver(NUM, text(`Verify PLICO-${code}`), { at: Date.now() - 3600_000 }), 200)
  assert.equal(JSON.parse((await db.verification.findFirstOrThrow({ where: { identifier: `wa:${code}` } })).value).phone, undefined, 'stale deliveries are ignored')
  console.log('✓ unsigned deliveries refused, stale ones ignored')

  assert.equal(await deliver(NUM, text(`Verify PLICO-${code.toLowerCase()}`)), 200)
  assert.equal(JSON.parse((await db.verification.findFirstOrThrow({ where: { identifier: `wa:${code}` } })).value).phone, PHONE)
  assert.equal(await deliver(OTHER, button(`yes:${code}`)), 200)
  assert.equal((await db.user.findUniqueOrThrow({ where: { id: A.id } })).verifiedPhone, null, 'only the number that sent the code can confirm')
  console.log('✓ the code is tied to the number that sent it')

  assert.equal(await deliver(NUM, button(`yes:${code}`)), 200)
  r = await A.call('GET', '/api/me/phone')
  assert.equal(r.body.phone, PHONE); assert.equal(r.body.pending, false); assert.ok(r.body.verifiedAt)
  assert.equal((await db.member.findUniqueOrThrow({ where: { id: spot } })).userId, A.id, 'the spot added under the number is theirs now')
  assert.equal(await deliver(NUM, button(`yes:${code}`)), 200) // Meta retries: harmless
  assert.equal((await A.call('GET', '/api/me/phone')).body.phone, PHONE)
  console.log('✓ "Yes, link it" verifies, links spots, and a retry changes nothing')

  // A recycled number: whoever proves it now takes it.
  const c2 = (await B.call('POST', '/api/me/phone/start', {})).body.code
  await deliver(NUM, text(`PLICO-${c2}`)); await deliver(NUM, button(`yes:${c2}`))
  assert.equal((await B.call('GET', '/api/me/phone')).body.phone, PHONE)
  assert.equal((await A.call('GET', '/api/me/phone')).body.phone, null)
  console.log('✓ a number proved by someone else moves to them')

  const c3 = (await A.call('POST', '/api/me/phone/start', {})).body.code
  await deliver(OTHER, text(`Verify PLICO-${c3}`)); await deliver(OTHER, button(`no:${c3}`))
  assert.equal(await db.verification.count({ where: { identifier: `wa:${c3}` } }), 0)
  assert.equal((await A.call('GET', '/api/me/phone')).body.phone, null)
  assert.equal((await B.call('DELETE', '/api/me/phone')).status, 200)
  assert.equal((await B.call('GET', '/api/me/phone')).body.phone, null)
  console.log('✓ "No" and removing a number')

  console.log('\nall WhatsApp checks passed')
} finally {
  await db.verification.deleteMany({ where: { identifier: { startsWith: 'wa:' }, OR: [{ value: { contains: A.id } }, { value: { contains: B.id } }] } })
  await db.group.deleteMany({ where: { id: gid } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } })
  await db.$disconnect()
}
