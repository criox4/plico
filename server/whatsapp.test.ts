// WhatsApp verification: signatures, codes, masking and reading Meta's webhook body. Run: node server/whatsapp.test.ts
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { codeIn, inbound, mask, newCode, signedBy } from './whatsapp.ts'

// Signatures: Meta's HMAC of the exact bytes, keyed by the app secret. Anything else is refused.
const raw = new TextEncoder().encode('{"object":"whatsapp_business_account","entry":[]}')
const sig = 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex')
assert.equal(signedBy(raw, sig, 'secret'), true)
assert.equal(signedBy(raw, sig.toUpperCase().replace('SHA256=', 'sha256='), 'secret'), true, 'hex case doesn’t matter')
assert.equal(signedBy(raw, sig, 'other secret'), false)
assert.equal(signedBy(new TextEncoder().encode('{"object":"x"}'), sig, 'secret'), false, 'a changed body fails')
assert.equal(signedBy(raw, undefined, 'secret'), false)
assert.equal(signedBy(raw, '', 'secret'), false)
assert.equal(signedBy(raw, sig.slice(7), 'secret'), false, 'the sha256= prefix is required')
assert.equal(signedBy(raw, 'sha256=abc', 'secret'), false, 'wrong length never reaches timingSafeEqual')

// Codes: six characters with no 0/O/1/I, found anywhere in the message, any case.
for (let i = 0; i < 200; i++) assert.match(newCode(), /^[A-HJ-NP-Z2-9]{6}$/)
assert.equal(codeIn('Verify PLICO-AB23CD'), 'AB23CD')
assert.equal(codeIn('verify plico-ab23cd please'), 'AB23CD')
assert.equal(codeIn('PLICO-AB2'), null)
assert.equal(codeIn('hello'), null)

// Masking: the owner recognises it, nobody can copy it.
assert.equal(mask('+919876543210'), '+91 98•••• 3210')
assert.equal(mask('+14155550123'), '+141••••0123')
assert.ok(!mask('+447700900123').includes('7700900'))

// A real-shaped webhook: a text, a button tap, a username-only sender, and a status update (skipped).
const now = Math.floor(Date.now() / 1000)
const body = { object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
  messaging_product: 'whatsapp', metadata: { display_phone_number: '919000000000', phone_number_id: '123' },
  contacts: [{ wa_id: '919876543210', user_id: 'IN.1234', profile: { name: 'Asha' } }],
  messages: [
    { from: '919876543210', from_user_id: 'IN.1234', id: 'wamid.1', timestamp: String(now), type: 'text', text: { body: 'Verify PLICO-AB23CD' } },
    { from: '919876543210', id: 'wamid.2', timestamp: String(now), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'yes:AB23CD', title: 'Yes, link it' } }, context: { id: 'wamid.0' } },
    { from_user_id: 'IN.5678', id: 'wamid.3', timestamp: String(now), type: 'text', text: { body: 'PLICO-AB23CD' } },
  ],
} }, { field: 'messages', value: { statuses: [{ id: 'wamid.0', status: 'read' }] } }] }] }
const got = inbound(body)
assert.equal(got.length, 3)
assert.deepEqual(got[0], { phone: '+919876543210', to: { to: '919876543210' }, at: now * 1000, text: 'Verify PLICO-AB23CD' })
assert.deepEqual(got[1], { phone: '+919876543210', to: { to: '919876543210' }, at: now * 1000, button: 'yes:AB23CD' })
assert.deepEqual(got[2], { phone: null, to: { recipient: 'IN.5678' }, at: now * 1000, text: 'PLICO-AB23CD' }, 'a username without a number proves nothing')
assert.deepEqual(inbound(null), [])
assert.deepEqual(inbound({ entry: [{ changes: [{ value: {} }] }] }), [])
console.log('whatsapp ok')
