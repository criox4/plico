import assert from 'node:assert/strict'
import { ME, pairwise, canon, effectOf, auditPayload, enqueue, rebase, changes, summary, type Op, type Snap, allocate, sharesError, split, balances, simplify, addMonth, runRecurring, toPaise, encodeShare, decodeShare, needsConfirm, parseSplitwise, fromSplitwise, parseQuick, itemSplit, friendParts, greedy, scrub, normPhone, friendsIn, findFriend, personKey, type Group } from './logic.ts'

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
// head counts: the number never reaches the title or the amount
const all = [ME, 'r', 'k', 'a']
assert.deepEqual(parseQuick('Dinner at Gunpowder 3360 split 4', mem), { amount: 336000, people: all, title: 'Dinner at Gunpowder', cat: 'food' })
assert.deepEqual(parseQuick('split 4 ways dinner 3360', mem), { amount: 336000, people: all, title: 'Dinner', cat: 'food' })
assert.deepEqual(parseQuick('Cab 900 for 4 people', mem), { amount: 90000, people: all, title: 'Cab', cat: 'transport' })
assert.deepEqual(parseQuick('Dinner 1200/4', mem), { amount: 120000, people: all, title: 'Dinner', cat: 'food' })
assert.deepEqual(parseQuick('Chai 120 3 log', mem), { amount: 12000, count: 3, title: 'Chai', cat: 'food' })
assert.deepEqual(parseQuick('Movie 900 split into 3', mem), { amount: 90000, count: 3, title: 'Movie', cat: 'fun' })
assert.deepEqual(parseQuick('Uber 850 with Arjun, split 2', mem), { amount: 85000, people: [ME, 'a'], title: 'Uber', cat: 'transport' })

// item split: extras follow item subtotals, totals add up exactly
const is = itemSplit([{ name: 'Burger', amount: 42000, who: [ME] }, { name: 'Pasta', amount: 58000, who: ['r'] }, { name: 'Beer x3', amount: 90000, who: [ME, 'r', 'k'] }], 10800)
assert.ok(!('error' in is))
if ('owed' in is) { assert.equal(Object.values(is.owed).reduce((a, b) => a + b, 0), 200800); assert.ok(is.owed[ME] > is.owed.k) }
assert.ok('error' in itemSplit([{ name: 'Fries', amount: 100, who: [] }], 0))
const disc = itemSplit([{ name: 'A', amount: 1000, who: [ME] }, { name: 'B', amount: 1000, who: ['k'] }], -200)
assert.deepEqual(disc, { owed: { [ME]: 900, k: 900 } })
console.log('capture ok')

// sync outbox: newer changes to an expense replace the queued one, keep its base, go to the back
const e1 = '/api/groups/g/expenses/x', mem1 = '/api/groups/g/members/m'
let q: Op[] = []
q = enqueue(q, { m: 'PUT', path: e1, body: 1, base: 3 }, false)
q = enqueue(q, { m: 'PUT', path: mem1, body: 'm' }, false)
q = enqueue(q, { m: 'PUT', path: e1, body: 2, base: 3 }, false)
assert.deepEqual(q.map(o => [o.path, o.body, o.base]), [[mem1, 'm', undefined], [e1, 2, 3]])
q = enqueue(q, { m: 'DELETE', path: e1, base: 3 }, false)
assert.equal(q.length, 2); assert.equal(q[1].m, 'DELETE')
// the op being sent is never touched; a new one queues behind it and is rebased when it lands
let r2: Op[] = [{ m: 'PUT', path: e1, body: 1, base: null }]
r2 = enqueue(r2, { m: 'PUT', path: e1, body: 2, base: null }, true)
assert.equal(r2.length, 2)
r2 = rebase(r2.slice(1), e1, 1)
assert.deepEqual(r2, [{ m: 'PUT', path: e1, body: 2, base: 1 }])
assert.deepEqual(rebase([{ m: 'PUT', path: mem1, body: 1 }], mem1, 4), [{ m: 'PUT', path: mem1, body: 1 }])

// history: versions described in words
const nm = (id: string) => ({ a: 'Asha', b: 'Bala', c: 'Chitra' })[id] ?? '?'
const v1: Snap = { title: 'Dinner', cat: 'food', date: '2026-09-26', amount: 120000, shares: [{ memberId: 'a', paid: 120000, owed: 40000 }, { memberId: 'b', paid: 0, owed: 40000 }, { memberId: 'c', paid: 0, owed: 40000 }] }
const v2: Snap = { ...v1, title: 'Dinner at Toit', amount: 150000, shares: [{ memberId: 'a', paid: 0, owed: 75000 }, { memberId: 'b', paid: 150000, owed: 75000 }] }
assert.deepEqual(changes(v1, v2, nm), ['name “Dinner” → “Dinner at Toit”', 'amount ₹1,200 → ₹1,500', 'paid by Asha → Bala', 'took Chitra out of the split'])
assert.deepEqual(changes(v1, v1, nm), [])
assert.equal(summary(v1, nm), '₹1,200, paid by Asha, split between 3')
const pay: Snap = { title: 'Settlement', cat: 'check', date: '2026-09-26', amount: 5000, settle: true, pending: true, shares: [{ memberId: 'b', paid: 5000, owed: 0 }, { memberId: 'a', paid: 0, owed: 5000 }] }
assert.deepEqual(changes(pay, { ...pay, pending: false }, nm), ['confirmed the payment arrived'])
assert.equal(summary(pay, nm), '₹50 from Bala to Asha')
console.log('sync ok')

// friends: pairwise balances follow who paid for whom
const trio: Group = { id: 't', name: 'T', kind: 'trip', theme: 'goa', members: [{ id: ME, name: 'Me' }, { id: 'r', name: 'R' }, { id: 'k', name: 'K' }], expenses: [
  { id: '1', title: 'Hotel', cat: 'stay', date: '2026-09-01', amount: 9000, paid: { [ME]: 9000 }, owed: { [ME]: 3000, r: 3000, k: 3000 } },
  { id: '2', title: 'Cab', cat: 'transport', date: '2026-09-01', amount: 600, paid: { r: 600 }, owed: { [ME]: 300, r: 300 } },
  { id: '3', title: 'Paid back', cat: 'check', date: '2026-09-02', amount: 1000, paid: { k: 1000 }, owed: { [ME]: 1000 }, settle: true, pending: true },
] }
assert.equal(pairwise(trio, ME, 'r'), 2700)   // R owes me 3000 for the hotel, I owe R 300 for the cab
assert.equal(pairwise(trio, 'r', ME), -2700)
assert.equal(pairwise(trio, ME, 'k'), 3000)   // the pending settlement doesn't count yet
assert.equal(pairwise(trio, 'r', 'k'), 0)
// the pairwise balances add up to the group balance
const bb = balances(trio)
assert.equal(pairwise(trio, ME, 'r') + pairwise(trio, ME, 'k'), bb[ME])

// audit: canonical JSON ignores key order; effects sum to zero and follow confirmations
assert.equal(canon({ b: 1, a: { d: [2, { y: 1, x: null }], c: 'x' } }), canon({ a: { c: 'x', d: [2, { x: null, y: 1 }] }, b: 1 }))
assert.equal(canon({ a: undefined, b: 1 }), '{"b":1}')
const s1: Snap = { title: 'D', cat: 'food', date: '2026-09-01', amount: 1200, shares: [{ memberId: 'a', paid: 1200, owed: 600 }, { memberId: 'b', paid: 0, owed: 600 }] }
assert.deepEqual(effectOf(null, s1), { a: 600, b: -600 })
assert.deepEqual(effectOf(s1, null), { a: -600, b: 600 })
assert.deepEqual(effectOf(s1, { ...s1, amount: 1500, shares: [{ memberId: 'a', paid: 1500, owed: 750 }, { memberId: 'b', paid: 0, owed: 750 }] }), { a: 150, b: -150 })
const st: Snap = { title: 'S', cat: 'check', date: '2026-09-01', amount: 500, settle: true, pending: true, shares: [{ memberId: 'b', paid: 500, owed: 0 }, { memberId: 'a', paid: 0, owed: 500 }] }
assert.deepEqual(effectOf(null, st), {})
assert.deepEqual(effectOf(st, { ...st, pending: false }), { a: -500, b: 500 })
const ent = { groupId: 'g', seq: 1, kind: 'expense.created', byName: 'A', at: '2026-09-01T00:00:00.000Z', effect: { b: -1, a: 1 }, prevHash: '0' }
assert.equal(auditPayload(ent), auditPayload({ ...ent, effect: { a: 1, b: -1 } }))
console.log('friends + audit ok')

// expenses with friends outside groups: one friend whole; several only when you paid, one part per friend ledger
assert.deepEqual(friendParts(900, { [ME]: 900 }, { [ME]: 450, 'b@x.in': 450 }), { parts: [{ key: 'b@x.in', amount: 900, paid: { [ME]: 900 }, owed: { [ME]: 450, 'b@x.in': 450 } }] })
assert.deepEqual(friendParts(900, { 'b@x.in': 900 }, { [ME]: 900 }), { parts: [{ key: 'b@x.in', amount: 900, paid: { 'b@x.in': 900 }, owed: { [ME]: 900 } }] })
assert.deepEqual(friendParts(900, { [ME]: 900 }, { [ME]: 300, 'b@x.in': 300, 'r@x.in': 300 }).parts?.map(p => [p.key, p.amount, p.owed]),
  [['b@x.in', 300, { 'b@x.in': 300 }], ['r@x.in', 300, { 'r@x.in': 300 }]])
assert.match((friendParts(900, { 'b@x.in': 900 }, { [ME]: 300, 'b@x.in': 300, 'r@x.in': 300 }) as { error: string }).error, /make it a group/)
assert.match((friendParts(900, { [ME]: 900 }, { [ME]: 900 }) as { error: string }).error, /Pick who/)
console.log('friends outside groups ok')

// fewest payments: exact for real groups; never more payments than greedy, always settles everyone
{
  const settle = (bal: Record<string, number>, t: { from: string; to: string; amount: number }[]) => {
    const b = { ...bal }; for (const x of t) { b[x.from] += x.amount; b[x.to] -= x.amount }
    return Object.values(b).every(v => v === 0) && t.every(x => x.amount > 0)
  }
  // Splitwise's article example: 9 debts, 3 payments.
  const art = { gabe: -4000, bob: 0, david: -1000, fred: -6000, charlie: 5000, ema: 6000 }
  assert.equal(simplify(art).length, 3); assert.ok(settle(art, simplify(art)))
  // Greedy's blind spot: pairing the largest amounts first takes 5 payments; spotting that c (+3) and a (−3) cancel takes 4.
  const tricky = { a: -300, b: 200, c: 300, d: 400, e: 200, f: -800 }
  assert.equal(greedy(tricky).length, 5); assert.equal(simplify(tricky).length, 4); assert.ok(settle(tricky, simplify(tricky)))
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  for (let t = 0; t < 400; t++) {
    const bal: Record<string, number> = {}; let tot = 0
    const size = 3 + Math.floor(rnd() * 9)
    for (let i = 0; i < size - 1; i++) { const v = Math.round((rnd() * 20 - 10)) * 100; bal['p' + i] = v; tot += v }
    bal['p' + (size - 1)] = -tot
    const out = simplify(bal)
    assert.ok(settle(bal, out), 'settles everyone')
    const nz = Object.values(bal).filter(v => v).length
    assert.ok(out.length <= Math.max(nz - 1, 0), 'never more than n-1')
  }
}
console.log('simplify ok')

// "via Ask Plico" is covered by the audit hash only when set: entries from before it existed hash the same.
{
  const base = { groupId: 'g', seq: 1, kind: 'expense.created', byName: 'Asha', at: '2026-09-27T00:00:00.000Z', effect: {}, prevHash: '0' }
  assert.equal(auditPayload({ ...base, via: null }), auditPayload(base))
  assert.notEqual(auditPayload({ ...base, via: 'ai' }), auditPayload(base))
  // A change folded with an Ask Plico one keeps the mark.
  const q = enqueue([{ m: 'PUT', path: '/api/groups/g/expenses/e', body: 1, base: 3, via: 'ai' }], { m: 'PUT', path: '/api/groups/g/expenses/e', body: 2, base: 4 }, false)
  assert.deepEqual(q, [{ m: 'PUT', path: '/api/groups/g/expenses/e', body: 2, base: 3, via: 'ai' }])
  console.log('via ok')
}

// Crash reports: emails and tokens in addresses never leave the phone.
{
  const e = scrub({ request: { url: 'https://plico.space/#/f/bala.k@gmail.com/settle' }, transaction: '#/claim/0123456789abcdef0123456789abcdef',
    breadcrumbs: [{ data: { url: '/api/invites/AbC123xyz/join' } }, { data: { url: '/api/public/claim/deadbeef' } }, { message: 'Navigated to #/add/f/riya@x.in' }, { message: '#/guardian/abc' }, { message: '#/g/5f0c-group-id' }],
    exception: { values: [{ value: 'No user karan.shah+test@splittr.test' }] } })
  assert.equal(e.request.url, 'https://plico.space/#/f/[hidden]/settle')
  assert.equal(e.transaction, '#/claim/[hidden]')
  assert.deepEqual(e.breadcrumbs.map((b: any) => b.data?.url ?? b.message), ['/api/invites/[hidden]/join', '/api/public/claim/[hidden]', 'Navigated to #/add/f/[hidden]', '#/guardian/[hidden]', '#/g/5f0c-group-id'])
  assert.equal(e.exception.values[0].value, 'No user [email]')
  assert.equal(scrub({ release: 'plico@0.1.0' }).release, 'plico@0.1.0', 'a release name is not an email')
  assert.equal(scrub('A.B@Mail.Example.IN').toString(), '[email]')
  console.log('crash report scrubbing ok')
}

// Phone numbers: one form everywhere, so the same person typed two ways is one person.
assert.equal(normPhone('98765 43210'), '+919876543210')
assert.equal(normPhone('098765-43210'), '+919876543210')
assert.equal(normPhone('919876543210'), '+919876543210')
assert.equal(normPhone('+91 (98765) 43210'), '+919876543210')
assert.equal(normPhone('+1 415 555 0100'), '+14155550100')
assert.equal(normPhone('12345'), null)
assert.equal(normPhone('5876543210'), null) // Indian mobiles start 6-9
assert.equal(normPhone('riya@x.com'), null)

// People: one friend per person, whichever way each group knows them.
{
  const grp = (id: string, members: Group['members'], kind: Group['kind'] = 'trip'): Group => ({ id, name: id, kind, theme: 'classic', members: [{ id: ME, name: 'Me' }, ...members], expenses: [] })
  const fs = friendsIn([
    grp('a', [{ id: 'm1', name: 'Bala K', email: 'bala@x.in', joined: true, uid: 'U1' }, { id: 'm2', name: 'Riya', phone: '+919876543210' }]),
    grp('b', [{ id: 'm3', name: 'Bala', email: 'bala@x.in' }, { id: 'm4', name: 'Me again', email: 'me@x.in' }]), // a placeholder Bala's account already has
    grp('c', [{ id: 'm5', name: 'Riya S', phone: '+919876543210' }], 'direct'),
  ], { id: 'U0', email: 'Me@x.in' })
  assert.deepEqual(fs.map(f => [f.key, f.name, f.spots.map(x => x.id)]), [['u:U1', 'Bala K', ['m1', 'm3']], ['p:+919876543210', 'Riya', ['m2', 'm5']]])
  assert.equal(fs[1].direct?.id, 'c')
  assert.equal(findFriend(fs, 'bala@x.in')?.key, 'u:U1', 'old /f/<email> links still open the friend')
  assert.equal(findFriend(fs, 'e:bala@x.in')?.key, 'u:U1')
  assert.equal(findFriend(fs, 'p:+919876543210')?.name, 'Riya')
  assert.equal(personKey({ id: 'x', name: 'Nobody' }), undefined)
  console.log('friends ok')
}
