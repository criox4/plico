// Who hears about what, what it says, and quiet hours. Run: node server/push.test.ts
import assert from 'node:assert/strict'
import { compose, pushesFor, quietUntil, local, prefsOf, prefFor } from './push-text.ts'

const people = [{ id: 'mA', userId: 'A' }, { id: 'mB', userId: 'B' }, { id: 'mC', userId: 'C' }, { id: 'mG', userId: null }]
const snap = (o: object) => ({ title: 'Dinner', amount: 90000, shares: [{ memberId: 'mA', paid: 90000, owed: 30000 }, { memberId: 'mB', paid: 0, owed: 30000 }, { memberId: 'mC', paid: 0, owed: 30000 }], ...o })

// A new expense: everyone in it but the person who added it; guests (no account) never.
let p = pushesFor({ kind: 'expense.created', byId: 'A', byName: 'Asha', after: snap({}), effect: { mA: 60000, mB: -30000, mC: -30000 } }, people)
assert.deepEqual(p.map(x => x.userId), ['B', 'C'])
assert.equal(p[0].data.share, 30000)

// An edit: only the people whose balance moved.
p = pushesFor({ kind: 'expense.edited', byId: 'B', byName: 'Bala', before: snap({}), after: snap({}), effect: { mA: 0, mB: 0, mC: -5000 } }, people)
assert.deepEqual(p.map(x => [x.userId, x.kind, x.data.delta]), [['C', 'expense.changed', -5000]])

// Settlements: claimed → payee; confirmed and rejected → payer.
const pay = (o: object) => ({ title: 'Settlement', amount: 30000, settle: true, shares: [{ memberId: 'mB', paid: 30000, owed: 0 }, { memberId: 'mA', paid: 0, owed: 30000 }], ...o })
assert.deepEqual(pushesFor({ kind: 'expense.created', byId: 'B', byName: 'Bala', after: pay({ pending: true }), effect: {} }, people).map(x => [x.userId, x.kind]), [['A', 'payment.claimed']])
assert.deepEqual(pushesFor({ kind: 'expense.edited', byId: 'A', byName: 'Asha', before: pay({ pending: true }), after: pay({}), effect: {} }, people).map(x => [x.userId, x.kind]), [['B', 'payment.confirmed']])
assert.deepEqual(pushesFor({ kind: 'expense.edited', byId: 'A', byName: 'Asha', before: pay({ pending: true }), after: pay({ rejected: true }), effect: {} }, people).map(x => [x.userId, x.kind]), [['B', 'payment.rejected']])

// Joins: the group hears; being linked on sign-up is silent; being added by email tells the person who added them.
assert.deepEqual(pushesFor({ kind: 'member.joined', byId: 'C', byName: 'Chitra', after: { how: 'invite link' }, effect: {} }, people).map(x => x.userId), ['A', 'B'])
assert.deepEqual(pushesFor({ kind: 'member.joined', byId: 'C', byName: 'Chitra', after: { how: 'email' }, effect: {} }, people), [])
assert.deepEqual(pushesFor({ kind: 'member.joined', byId: 'C', byName: 'Chitra', after: { how: 'email', addedBy: 'Asha' }, effect: {} }, people).map(x => [x.userId, x.kind]), [['C', 'member.added']])

// Text: one row is specific; a batch says how many, from whom, and the net effect; amounts can be hidden.
assert.equal(compose([{ kind: 'expense.created', data: { by: 'Bala', title: 'Scooters', share: 60000, delta: -60000 } }], 'Goa ’26', true).body, 'Bala added “Scooters” · your share ₹600')
assert.equal(compose([{ kind: 'payment.claimed', data: { by: 'Bala', amount: 84000 } }], 'Goa ’26', false).body, 'Bala marked as paid to you. Did it arrive?')
const batch = compose([
  { kind: 'expense.created', data: { by: 'Bala', title: 'A', share: 10000, delta: -10000 } },
  { kind: 'expense.created', data: { by: 'Chitra', title: 'B', share: 20000, delta: -20000 } },
  { kind: 'member.joined', data: { by: 'Karan' } },
], 'Goa ’26', true)
assert.equal(batch.body, 'Bala and Chitra added 2 expenses; Karan joined · your balance −₹300')
assert.ok(!compose([{ kind: 'expense.changed', data: { by: 'B', title: 'x', how: 'edited', delta: 500 } }, { kind: 'expense.changed', data: { by: 'B', title: 'y', how: 'deleted', delta: 700 } }], 'G', false).body.includes('₹'))

// Quiet hours: 22:00–08:00 local.
const ist = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 27, h, m) - 330 * 60_000) // that time in India
assert.equal(quietUntil('Asia/Kolkata', ist(14)), null)
assert.equal(quietUntil('Asia/Kolkata', ist(23, 30))!.getTime(), ist(8).getTime() + 864e5)
assert.equal(quietUntil('Asia/Kolkata', ist(7, 45))!.getTime(), ist(8).getTime())
assert.equal(quietUntil('Not/AZone', ist(14)), null) // falls back to India
assert.equal(local('Asia/Kolkata', ist(11)).day, 0) // 2026-09-27 is a Sunday

assert.equal(compose([{ kind: 'friend.added', data: { by: 'Bala' } }], null, true).body, 'Bala added you as a friend.')

// Preferences: missing means on; each kind maps to one switch.
assert.deepEqual(prefsOf({ nudge: false }), { payments: true, activity: true, reminders: true, nudge: false, quiet: true, amounts: true })
assert.deepEqual(['payment.claimed', 'remind', 'nudge', 'expense.created', 'member.joined'].map(prefFor), ['payments', 'reminders', 'nudge', 'activity', 'activity'])
console.log('push ok')
