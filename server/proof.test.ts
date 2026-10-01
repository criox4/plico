// Checking a UPI receipt against a settlement. Run: node server/proof.test.ts
import assert from 'node:assert/strict'
import { NO_READ, checkReceipt, succeeded, type Settlement } from './proof.ts'

const at = new Date('2026-10-01T10:00:00+05:30')
const s: Settlement = { amount: 84000, createdAt: at, payee: { name: 'Asha Sharma', upi: 'asha.s@okhdfc', upi2: null } }
const ok = { amount: 84000, utr: '412345678901', payee: 'Asha S · ASHA.S@OKHDFC', at: '2026-10-01T09:58:00+05:30', status: 'Payment Successful' }

// Everything lines up: verified.
assert.deepEqual(checkReceipt(ok, s, false), { checks: { amount: true, payee: true, time: true, fresh: true }, verified: true })
// Each check on its own stops it.
assert.equal(checkReceipt({ ...ok, amount: 8400 }, s, false).checks.amount, false)
assert.equal(checkReceipt({ ...ok, amount: 8400 }, s, false).verified, false)
assert.equal(checkReceipt(ok, s, true).checks.fresh, false, 'its transaction ID already proved another settlement')
assert.equal(checkReceipt(ok, s, true).verified, false)
assert.equal(checkReceipt({ ...ok, at: '2026-10-05T10:00:00+05:30' }, s, false).checks.time, false, 'four days later')
assert.equal(checkReceipt({ ...ok, at: '2026-09-28T11:00:00+05:30' }, s, false).checks.time, true, 'within three days before')
assert.equal(checkReceipt({ ...ok, at: 'yesterday' }, s, false).checks.time, false)
assert.equal(checkReceipt({ ...ok, status: 'Payment pending' }, s, false).verified, false, 'all checks pass but it isn’t done')

// The payee: a UPI ID in any case (either of theirs), or the first name loosely; nobody else.
const payee = (shown: string | null, p: Settlement['payee'] = s.payee) => checkReceipt({ ...ok, payee: shown }, { ...s, payee: p }, false).checks.payee
assert.equal(payee('Paid to asha.s@OKHDFC'), true)
assert.equal(payee('9876543210@ybl', { ...s.payee, upi2: '9876543210@YBL' }), true)
assert.equal(payee('ASHA R SHARMA'), true)
assert.equal(payee('Ashaa Traders'), true) // ponytail: loose by design
assert.equal(payee('Bala Iyer · bala@okaxis'), false)
assert.equal(payee('Mr Sharma'), false)
assert.equal(payee(null), false)
assert.equal(payee('Al Khan', { name: 'Al', upi: null, upi2: null }), false, 'too short a name to match on')

// Statuses as banks write them.
assert.deepEqual(['Payment Successful', 'Paid', 'Money sent', 'Completed', 'Transaction successful'].map(succeeded), [true, true, true, true, true])
assert.deepEqual(['Failed', 'Payment unsuccessful', 'Pending', 'Processing', 'Reversed', 'Refunded', null].map(succeeded), [false, false, false, false, false, false, false])

// No read at all (AI off, or only a typed transaction ID): nothing passes but freshness, so nothing is verified.
assert.deepEqual(checkReceipt(NO_READ, s, false), { checks: { amount: false, payee: false, time: false, fresh: true }, verified: false })
console.log('proof ok')
