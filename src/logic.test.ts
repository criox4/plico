import assert from 'node:assert/strict'
import { allocate, sharesError, split, balances, simplify, addMonth, runRecurring, toPaise, encodeShare, decodeShare, type Group } from './logic.ts'

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)

assert.deepEqual(allocate(1000, { a: 1, b: 1, c: 1 }), { a: 334, b: 333, c: 333 })
assert.equal(sum(allocate(275900, { a: 2, b: 1, c: 1, d: 3 })), 275900)
assert.deepEqual(split(10000, 'exact', { a: 60, b: 40 }), { owed: { a: 6000, b: 4000 } })
assert.ok('error' in split(10000, 'exact', { a: 60 }))
assert.ok('error' in split(10000, 'percent', { a: 50, b: 20 }))
assert.deepEqual(split(10000, 'percent', { a: 50, b: 50 }), { owed: { a: 5000, b: 5000 } })
assert.equal(toPaise('1,234.56'), 123456)

// A owes B 900, B owes C 600, C owes A 300 → one payment A→B 300... net: A -600, B +300, C +300
const g: Group = { id: 'g', name: 'T', kind: 'trip', theme: 'goa', members: ['a', 'b', 'c'].map(id => ({ id, name: id })), expenses: [
  { id: '1', title: '', cat: '', date: '2026-01-31', amount: 900, paid: { b: 900 }, owed: { a: 900 } },
  { id: '2', title: '', cat: '', date: '2026-01-31', amount: 600, paid: { c: 600 }, owed: { b: 600 } },
  { id: '3', title: '', cat: '', date: '2026-01-31', amount: 300, paid: { a: 300 }, owed: { c: 300 }, repeat: { next: '2026-02-28', day: 31 } },
] }
const t = simplify(balances(g))
assert.equal(t.length, 2)
assert.equal(sum(balances(g)), 0)
// settlement as an expense zeroes balances
for (const x of t) g.expenses.push({ id: 's', title: '', cat: '', date: '', amount: x.amount, paid: { [x.from]: x.amount }, owed: { [x.to]: x.amount }, settle: true })
assert.deepEqual(simplify(balances(g)), [])

assert.equal(addMonth('2026-01-31', 31), '2026-02-28')
assert.equal(addMonth('2026-02-28', 31), '2026-03-31')
assert.equal(addMonth('2026-12-15', 15), '2027-01-15')
assert.ok(runRecurring(g, '2026-04-01'))
assert.equal(g.expenses.filter(e => e.amount === 300 && !e.settle).length, 3) // original + Feb 28 + Mar 31
assert.equal(g.expenses[2].repeat!.next, '2026-04-30')

const sh = { g: "Goa '26 🌴", f: 'Karan', t: 'Arjun', v: 'arjun@okhdfc', a: 184200 }
assert.deepEqual(decodeShare(encodeShare(sh)), sh)
assert.equal(decodeShare('garbage'), null)
const m = new Set(['a', 'b'])
assert.equal(sharesError(1000, { a: 1000 }, { a: 500, b: 500 }, m), null)
assert.ok(sharesError(1000, { a: 900 }, { a: 500, b: 500 }, m))
assert.ok(sharesError(1000, { a: 1000 }, { a: 500, x: 500 }, m))
assert.ok(sharesError(1000, { a: 1000.5 }, { a: 1000.5 }, m))
assert.ok(sharesError(0, {}, {}, m))
console.log('ok')
