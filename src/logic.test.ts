import assert from 'node:assert/strict'
import { ME, allocate, sharesError, split, balances, simplify, addMonth, runRecurring, toPaise, encodeShare, decodeShare, needsConfirm, parseSplitwise, fromSplitwise, parseQuick, itemSplit, type Group } from './logic.ts'

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
// a settlement waiting for the payee doesn't move balances until it's confirmed
const p: Group = { id: 'p', name: 'P', kind: 'friends', theme: 'classic', members: [{ id: ME, name: 'Me' }, { id: 'r', name: 'Rahul', joined: true }, { id: 'q', name: 'Guest' }],
  expenses: [{ id: 'd', title: 'Dinner', cat: 'food', date: '2026-09-26', amount: 2000, paid: { r: 2000 }, owed: { [ME]: 1000, r: 1000 } }] }
p.expenses.push({ id: 's1', title: 'Settlement', cat: 'check', date: '2026-09-26', amount: 1000, paid: { [ME]: 1000 }, owed: { r: 1000 }, settle: true, pending: true })
assert.equal(balances(p)[ME], -1000)
delete p.expenses[1].pending
assert.equal(balances(p)[ME], 0)
assert.equal(needsConfirm(p, 'r'), true) // Rahul has an account: he confirms
assert.equal(needsConfirm(p, 'q'), false) // a guest can't confirm
assert.equal(needsConfirm(p, ME), false) // I'm the payee: my word is enough
console.log('ok')

// Splitwise import reproduces Splitwise's balances
const csv = `Date,Description,Category,Cost,Currency,Asha Rao,Bilal,"Chen, Li"
2024-01-05,Dinner,Dining out,90.00,INR,60.00,-30.00,-30.00
2024-01-06,"Cab, airport",Taxi,45.00,INR,-15.00,30.00,-15.00
2024-01-07,Payment,Payment,15.00,INR,-15.00,15.00,0.00
2024-01-08,Souvenir,General,20.00,USD,10.00,-10.00,0.00

2024-01-09,Total balance, , ,INR,30.00,15.00,-45.00
`
const sw = parseSplitwise(csv)
assert.ok(!('error' in sw))
if (!('error' in sw)) {
  assert.deepEqual(sw.people, ['Asha Rao', 'Bilal', 'Chen, Li'])
  assert.equal(sw.rows.length, 3); assert.equal(sw.skipped, 1)
  const ids = ['a', 'b', 'c']
  const gi: Group = { id: 'i', name: 'I', kind: 'trip', theme: 'goa', members: ids.map(i => ({ id: i, name: i })), expenses: sw.rows.map(r => fromSplitwise(r, ids)!) }
  const bal = balances(gi)
  assert.deepEqual([bal.a, bal.b, bal.c], [3000, 1500, -4500])
  assert.ok(gi.expenses.every(e => !sharesError(e.amount, e.paid, e.owed, new Set(ids))))
  assert.equal(gi.expenses[0].amount, 9000); assert.equal(gi.expenses[0].cat, 'food'); assert.ok(gi.expenses[2].settle)
}
assert.ok('error' in parseSplitwise('hello,world'))
console.log('splitwise ok')

// quick add
const mem = [{ id: ME, name: 'Me' }, { id: 'r', name: 'Riya Sen' }, { id: 'k', name: 'Karan' }, { id: 'a', name: 'Arjun' }]
assert.deepEqual(parseQuick('Dinner 3200 paid by me split everyone except Riya', mem), { amount: 320000, payer: ME, people: [ME, 'k', 'a'], title: 'Dinner', cat: 'food' })
assert.deepEqual(parseQuick('Uber 850 me and Arjun only, Karan paid', mem), { amount: 85000, payer: 'k', people: [ME, 'a'], title: 'Uber', cat: 'transport' })
assert.deepEqual(parseQuick('Rent 65k', mem), { amount: 6500000, title: 'Rent', cat: 'rent' })
assert.deepEqual(parseQuick('₹1,450.50 groceries with riya', mem), { amount: 145050, people: [ME, 'r'], title: 'Groceries', cat: 'groceries' })
assert.equal(parseQuick('Blinkit 640', mem).cat, 'groceries'); assert.equal(parseQuick('BESCOM 1240', mem).cat, 'bills'); assert.equal(parseQuick('Swiggy instamart 300', mem).cat, 'groceries')
assert.equal(parseQuick('Coffee', mem).amount, undefined)

// item split: extras follow item subtotals, totals add up exactly
const is = itemSplit([{ name: 'Burger', amount: 42000, who: [ME] }, { name: 'Pasta', amount: 58000, who: ['r'] }, { name: 'Beer x3', amount: 90000, who: [ME, 'r', 'k'] }], 10800)
assert.ok(!('error' in is))
if ('owed' in is) { assert.equal(Object.values(is.owed).reduce((a, b) => a + b, 0), 200800); assert.ok(is.owed[ME] > is.owed.k) }
assert.ok('error' in itemSplit([{ name: 'Fries', amount: 100, who: [] }], 0))
const disc = itemSplit([{ name: 'A', amount: 1000, who: [ME] }, { name: 'B', amount: 1000, who: ['k'] }], -200)
assert.deepEqual(disc, { owed: { [ME]: 900, k: 900 } })
console.log('capture ok')
