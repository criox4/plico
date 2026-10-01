import type { ServerExpense, Snap } from './schema'
// All money is integer paise. Never floats past the input box.
import type { ThemeId as Theme } from './themes'
export type { Theme }
export type Id = string
export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares'
export type Kind = 'trip' | 'home' | 'couple' | 'friends' | 'family' | 'office' | 'direct' // direct: two friends, no group
export type Tone = 'gentle' | 'normal' | 'shameless'

export type Member = {
  id: Id; name: string; upi?: string
  upi2?: string // backup UPI ID
  email?: string; phone?: string // invite targets for people without the app (joined: the account's own email)
  joined?: boolean // linked to an account
  uid?: string // that account's id
  invited?: boolean // an invite has gone out
  addedBy?: string // not joined yet and added by someone else: only they can change the UPI IDs and email (their name)
  image?: string // their account's profile picture (photo path, emoji:…, plico:…)
}
export type Expense = {
  id: Id
  title: string
  cat: string
  date: string // YYYY-MM-DD
  amount: number
  paid: Record<Id, number>
  owed: Record<Id, number>
  mode?: SplitMode
  input?: Record<Id, number> // raw split input, kept so edits reopen as entered
  settle?: true
  receipt?: string // photo file name, stored with the group
  pending?: true // settlement not verified yet (payee or screenshot); it counts straight away, settling first like Splitwise
  rejected?: true // the payee says it hasn't arrived; doesn't move balances
  verifiedBy?: 'payee' | 'screenshot' // how a settlement was verified
  proof?: Proof // how the payer says they paid, and what their receipt showed
  repeat?: { next: string; day: number } // monthly
  v?: number // the server version this copy is; edits send it so the server can spot stale ones
}
export type Proof = NonNullable<ServerExpense['proof']>
export type Group = {
  id: Id
  name: string
  kind: Kind
  theme: Theme
  track?: boolean // family-style: show balances, never nag
  emoji?: string // the group's face on home
  cover?: string // cover photo file name
  selfId?: Id // my member id on the server; the UI always calls me ME
  mine?: boolean // I created it (only the creator can delete)
  members: Member[]
  expenses: Expense[]
}
export type Transfer = { from: Id; to: Id; amount: number }

export const ME = 'me'
export const uid = () => crypto.randomUUID()
export const today = () => new Date().toLocaleDateString('en-CA')

const fmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2, minimumFractionDigits: 0 })
export const inr = (p: number) => fmt.format(Math.abs(p) / 100)
export const toPaise = (s: string | number) => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100) || 0

/** Split `total` proportionally to weights; leftover paise go to the largest remainders so parts always sum to total. */
export function allocate(total: number, weights: Record<Id, number>): Record<Id, number> {
  const ids = Object.keys(weights).filter(k => weights[k] > 0)
  const sum = ids.reduce((s, k) => s + weights[k], 0)
  if (!sum) return {}
  const raw = ids.map(k => ({ k, v: (total * weights[k]) / sum }))
  const out: Record<Id, number> = {}
  raw.forEach(r => (out[r.k] = Math.floor(r.v)))
  let left = total - raw.reduce((s, r) => s + out[r.k], 0)
  raw.sort((a, b) => (b.v % 1) - (a.v % 1) || a.k.localeCompare(b.k))
  for (let i = 0; left > 0; i++, left--) out[raw[i % raw.length].k]++
  return out
}

/** input: equal → 1/0 flags, exact → rupees, percent → %, shares → multipliers. */
export function split(total: number, mode: SplitMode, input: Record<Id, number>): { owed: Record<Id, number> } | { error: string } {
  if (total <= 0) return { error: 'Enter an amount' }
  if (mode === 'exact') {
    const owed: Record<Id, number> = {}
    for (const k in input) if (input[k] > 0) owed[k] = toPaise(input[k])
    const diff = total - Object.values(owed).reduce((a, b) => a + b, 0)
    return diff ? { error: `${inr(diff)} ${diff > 0 ? 'left to assign' : 'over the total'}` } : { owed }
  }
  if (mode === 'percent') {
    const pct = Object.values(input).reduce((a, b) => a + (b > 0 ? b : 0), 0)
    if (Math.abs(pct - 100) > 0.001) return { error: `Percentages add up to ${+pct.toFixed(2)}%, need 100%` }
  }
  const owed = allocate(total, input)
  return Object.keys(owed).length ? { owed } : { error: 'Pick at least one person' }
}

/** Net per member: + means the group owes them. */
export function balances(g: Group): Record<Id, number> {
  const b: Record<Id, number> = Object.fromEntries(g.members.map(m => [m.id, 0]))
  for (const e of g.expenses) {
    if (e.rejected) continue
    for (const k in e.paid) b[k] = (b[k] ?? 0) + e.paid[k]
    for (const k in e.owed) b[k] = (b[k] ?? 0) - e.owed[k]
  }
  return b
}

/**
 * What a owes b (negative) or b owes a (positive) from the expenses themselves, not the simplified group debts:
 * each person's share is owed to the payers in proportion to what they paid. This is the friend-to-friend balance.
 */
export function pairwise(g: Group, a: Id, b: Id): number {
  let n = 0
  for (const e of g.expenses) {
    if (e.rejected || !e.amount) continue
    n += ((e.owed[b] ?? 0) * (e.paid[a] ?? 0) - (e.owed[a] ?? 0) * (e.paid[b] ?? 0)) / e.amount
  }
  return Math.round(n)
}

/** A settlement asks the payee to verify it unless the payee recorded it or can't (a guest without an account). It counts either way. */
export const needsConfirm = (g: Group, to: Id) => to !== ME && !!g.members.find(m => m.id === to)?.joined

/** A settlement's quiet status: how it was verified, or that it hasn't been yet ('' for plain or rejected ones). */
export const verifyLabel = (e: Expense) =>
  e.rejected ? '' : e.verifiedBy === 'screenshot' ? 'Verified · screenshot' : e.verifiedBy ? 'Verified' : e.pending ? 'Not verified' : ''
const CHECKS = { amount: 'amount', payee: 'recipient', time: 'time', fresh: 'used before' } as const
/** The receipt checks that failed, in words: "amount / time". '' when there were none or all passed. */
export const missedChecks = (p?: Proof) => (p?.checks ? (Object.keys(CHECKS) as (keyof typeof CHECKS)[]).filter(k => !p.checks![k]).map(k => CHECKS[k]).join(' / ') : '')
/** A UPI transaction ID in full for the two people in the payment, the last 4 digits for everyone else. */
export const showUtr = (utr: string, full: boolean) => (full ? utr : `•••• ${utr.slice(-4)}`)
/** A settlement paid to me that I haven't said yes or no to. */
export const toCheck = (e: Expense) => !!(e.settle && e.pending && !e.rejected && e.owed[ME] && !e.paid[ME])

/** The fewest payments that settle everyone. The minimum is (people with a balance) − (the most groups they can be
 * split into that each sum to zero), and each such group settles in (its size − 1) payments. Finding that split is
 * NP-hard (subset sum), so it's solved exactly by dynamic programming over subsets up to EXACT people with a
 * balance (any real group), and by the greedy method beyond that. Anyone may pay anyone within a group. */
export const EXACT = 16
export function simplify(bal: Record<Id, number>): Transfer[] {
  const ids = Object.keys(bal).filter(k => bal[k]).sort()
  if (ids.length > EXACT || ids.length < 4) return greedy(bal)
  const n = ids.length, N = 1 << n
  const sum = new Float64Array(N), best = new Uint8Array(N), via = new Uint8Array(N)
  for (let m = 1; m < N; m++) {
    const low = 31 - Math.clz32(m & -m)
    sum[m] = sum[m & (m - 1)] + bal[ids[low]]
    let b = -1
    for (let i = 0; i < n; i++) if (m >> i & 1 && best[m ^ (1 << i)] > b) { b = best[m ^ (1 << i)]; via[m] = i }
    best[m] = b + (sum[m] === 0 ? 1 : 0)
  }
  // Walk the best removal order back: each time the remaining people sum to zero, what was removed since is one group.
  const out: Transfer[] = []
  let m = N - 1, group: Id[] = []
  while (m) {
    const i = via[m]
    group.push(ids[i]); m ^= 1 << i
    if (sum[m] === 0) { out.push(...greedy(Object.fromEntries(group.map(k => [k, bal[k]])))); group = [] }
  }
  return out
}

/** Greedy largest-debtor → largest-creditor: at most n-1 payments. */
export function greedy(bal: Record<Id, number>): Transfer[] {
  const cr = Object.entries(bal).filter(([, v]) => v > 0).map(([k, v]) => ({ k, v }))
  const dr = Object.entries(bal).filter(([, v]) => v < 0).map(([k, v]) => ({ k, v: -v }))
  const out: Transfer[] = []
  while (cr.length && dr.length) {
    cr.sort((a, b) => b.v - a.v)
    dr.sort((a, b) => b.v - a.v)
    const amount = Math.min(cr[0].v, dr[0].v)
    out.push({ from: dr[0].k, to: cr[0].k, amount })
    cr[0].v -= amount
    dr[0].v -= amount
    if (!cr[0].v) cr.shift()
    if (!dr[0].v) dr.shift()
  }
  return out
}

export function addMonth(date: string, day: number): string {
  const [y, m] = date.split('-').map(Number) // m is 1-based, so Date.UTC(y, m) is next month
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(day, last))).toISOString().slice(0, 10)
}

/** Materialise any monthly repeats that are due. Returns true if the group changed. */
export function runRecurring(g: Group, now = today()): boolean {
  let changed = false
  for (const e of [...g.expenses]) {
    while (e.repeat && e.repeat.next <= now) {
      g.expenses.push({ ...e, id: `${e.id}:${e.repeat.next}`, date: e.repeat.next, repeat: undefined })
      e.repeat.next = addMonth(e.repeat.next, e.repeat.day)
      changed = true
    }
  }
  return changed
}

export const upiLink = (vpa: string, name: string, paise: number, note: string) =>
  'upi://pay?' + new URLSearchParams({ pa: vpa, pn: name, am: (paise / 100).toFixed(2), cu: 'INR', tn: note.slice(0, 50) })

/** A phone number as +<country><number>, or null. Bare Indian mobiles (98765 43210, 098…, 91…) get +91. */
export function normPhone(s = ''): string | null {
  const t = s.trim(), d = t.replace(/[\s().-]/g, '')
  if (!/^\+?\d+$/.test(d)) return null
  if (d.startsWith('+')) return /^\+[1-9]\d{7,14}$/.test(d) ? d : null
  const n = d.replace(/^0(?=[6-9]\d{9}$)/, '').replace(/^91(?=[6-9]\d{9}$)/, '')
  return /^[6-9]\d{9}$/.test(n) ? '+91' + n : null
}
export const isVpa = (s = '') => /^[\w.-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,64}$/.test(s)

// Share payload lives in the URL hash: no server ever sees it.
export type Share = { g: string; f: string; t: string; v?: string; a: number }
export const encodeShare = (s: Share) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(s)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export function decodeShare(p: string): Share | null {
  try {
    const bin = atob(p.replace(/-/g, '+').replace(/_/g, '/'))
    const s = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))))
    return typeof s.a === 'number' && s.a > 0 && typeof s.t === 'string' ? s : null
  } catch {
    return null
  }
}

/** Server-side guard: an expense is valid only if paid and owed both sum to the amount, over known members. */
export function sharesError(amount: number, paid: Record<Id, number>, owed: Record<Id, number>, members: Set<Id>): string | null {
  const sum = (o: Record<Id, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  const all = [...Object.entries(paid), ...Object.entries(owed)]
  if (!Number.isInteger(amount) || amount <= 0) return 'Amount must be a positive number of paise'
  if (all.some(([, v]) => !Number.isInteger(v) || v < 0)) return 'Shares must be whole, non-negative paise'
  if (all.some(([k]) => !members.has(k))) return 'Every person must belong to the group'
  if (sum(paid) !== amount) return 'What was paid must add up to the amount'
  if (sum(owed) !== amount) return 'What is owed must add up to the amount'
  return null
}

// ---------- Splitwise import ----------
/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++ } else if (c === '"') q = false; else f += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = '' }
    else f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
  return rows.filter(r => r.some(x => x.trim()))
}

const SW_CATS: [RegExp, string][] = [
  [/grocer/i, 'groceries'], [/dining|food|restaurant/i, 'food'], [/liquor|alcohol|drink/i, 'drinks'],
  [/hotel|lodg/i, 'stay'], [/taxi|car|fuel|gas\/|bus|train|plane|flight|parking|transport|bicycle/i, 'transport'],
  [/rent|mortgage/i, 'rent'], [/electric|utilit|water|internet|phone|tv|heat|trash|bill/i, 'bills'],
  [/clean|maid|help|household/i, 'help'], [/entertain|game|movie|music|sport|fun/i, 'fun'],
]
export type SwRow = { date: string; title: string; cat: string; amount: number; net: number[]; settle: boolean }
export type Splitwise = { people: string[]; rows: SwRow[]; skipped: number }

/** Splitwise's group export: Date, Description, Category, Cost, Currency, then one net column per person
 *  (positive = paid more than their share). Non-INR rows and the "Total balance" line are skipped. */
export function parseSplitwise(text: string): Splitwise | { error: string } {
  const [head, ...body] = parseCsv(text.replace(/^﻿/, ''))
  if (!head || head.length < 6 || !/date/i.test(head[0]) || !/cost/i.test(head[3])) return { error: 'This doesn’t look like a Splitwise export. In Splitwise, open the group, then Settings → Export as spreadsheet.' }
  const people = head.slice(5).map(p => p.trim()).filter(Boolean)
  const rows: SwRow[] = []
  let skipped = 0
  for (const r of body) {
    if (/total balance/i.test(r[1] ?? '')) continue
    const date = (r[0] ?? '').trim().slice(0, 10)
    const amount = toPaise(r[3] ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || amount <= 0 || (r[4] ?? '').trim().toUpperCase() !== 'INR') { skipped++; continue }
    const net = people.map((_, i) => toPaise((r[5 + i] ?? '').trim() || '0'))
    const drift = net.reduce((a, b) => a + b, 0) // rounding: nets should sum to zero
    if (drift) { const k = net.indexOf(drift > 0 ? Math.max(...net) : Math.min(...net)); net[k] -= drift }
    const cat = (r[2] ?? '').trim()
    rows.push({ date, title: (r[1] ?? '').trim() || 'Expense', cat, amount, net, settle: /^payment$/i.test(cat) })
  }
  return { people, rows, skipped }
}

/** Nets → paid/owed that reproduce Splitwise's balances exactly. The biggest payer also carries their own share. */
export function fromSplitwise(row: SwRow, ids: Id[]): Expense | null {
  const pos = row.net.map((v, i) => [i, v] as const).filter(([, v]) => v > 0)
  if (!pos.length) return null
  const paid: Record<Id, number> = {}, owed: Record<Id, number> = {}
  if (row.settle) {
    const neg = row.net.map((v, i) => [i, v] as const).filter(([, v]) => v < 0)
    if (pos.length !== 1 || neg.length !== 1) return null
    return { id: uid(), title: 'Settlement', cat: 'check', date: row.date, amount: pos[0][1], paid: { [ids[pos[0][0]]]: pos[0][1] }, owed: { [ids[neg[0][0]]]: pos[0][1] }, settle: true }
  }
  const sumPos = pos.reduce((a, [, v]) => a + v, 0)
  const amount = Math.max(row.amount, sumPos)
  const top = pos.reduce((a, b) => (b[1] > a[1] ? b : a))[0]
  row.net.forEach((v, i) => {
    const extra = i === top ? amount - sumPos : 0
    if (v > 0 || extra) paid[ids[i]] = Math.max(v, 0) + extra
    if (v < 0 || extra) owed[ids[i]] = Math.max(-v, 0) + extra
  })
  const cat = SW_CATS.find(([re]) => re.test(row.cat))?.[1] ?? 'other'
  return { id: uid(), title: row.title, cat, date: row.date, amount, paid, owed }
}

// ---------- quick add: "Dinner 3200 paid by Karan except Riya" ----------
/** `count`: a head count ("split 4") that didn't match the group's size, so who's in is left to the person. */
export type Quick = { title?: string; amount?: number; payer?: Id; people?: Id[]; cat?: string; count?: number }

/** Offline category from brands and everyday words Indians actually type. Order matters: first match wins. */
const VENDOR_CATS: [RegExp, string][] = [
  [/\b(blinkit|zepto|big ?basket|instamart|dmart|jio ?mart|reliance (fresh|smart)|more (store|supermarket)|nature'?s basket|grocer(y|ies)|sabzi|vegetables?|kirana)\b/i, 'groceries'],
  [/\b(swiggy|zomato|eatsure|domino'?s|mcdonald'?s|mcd|kfc|burger king|pizza hut|subway|starbucks|ccd|cafe coffee day|chai|haldiram'?s?|biryani|dinner|lunch|breakfast|brunch|snacks?|food|restaurant|dhaba|cafe|thali)\b/i, 'food'],
  [/\b(beers?|brewpub|pub|bar|wine|whisky|drinks?|daaru|toit)\b/i, 'drinks'],
  [/\b(uber|ola|rapido|namma yatri|blusmart|metro|auto|cab|taxi|irctc|train|redbus|bus|indigo|air india|akasa|vistara|flight|petrol|diesel|fuel|fastag|toll|parking)\b/i, 'transport'],
  [/\b(oyo|airbnb|treebo|fabhotels?|zostel|hotel|hostel|homestay|resort|villa|stay)\b/i, 'stay'],
  [/\b(bookmyshow|pvr|inox|movie|netflix|hotstar|prime video|spotify|concert|tickets?|bowling|games?)\b/i, 'fun'],
  [/\b(rent|nobroker|deposit|maintenance)\b/i, 'rent'],
  [/\b(jio|airtel|vi|bsnl|act fibernet|wifi|wi-fi|broadband|recharge|dth|tata play|electricity|bescom|msedcl|tangedco|bses|tata power|adani electricity|cesc|kseb|igl|mgl|gas|cylinder|water bill|bwssb|djb|bills?)\b/i, 'bills'],
  [/\b(maid|cook|driver|urban company|cleaning|laundry|dhobi|help)\b/i, 'help'],
]
export const categoryOf = (text: string) => VENDOR_CATS.find(([re]) => re.test(text))?.[1]
/** Offline, rule-based: an amount (3200, 3,200, ₹3.2k, 65k), who paid ("paid by X", "X paid", "I paid"),
 *  who's in ("with A and B", "A, B only", "except C", "everyone"). Names match group members by prefix. */
/** A spoken or written name → a member: "me", a full name, a first name, or a prefix of 3+ letters. */
export function matchMember(w: string, members: { id: Id; name: string }[]): Id | undefined {
  const x = w.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '')
  if (!x) return undefined
  if (/^(me|i|myself|you)$/.test(x)) return ME
  return members.find(m => m.id !== ME && m.name.toLowerCase() === x)?.id ?? members.find(m => m.id !== ME && m.name.toLowerCase().split(/\s+/)[0] === x)?.id
    ?? members.find(m => m.id !== ME && x.length >= 3 && m.name.toLowerCase().startsWith(x))?.id
}

export function parseQuick(text: string, members: { id: Id; name: string }[]): Quick {
  let t = ` ${text.trim()} `
  const out: Quick = {}
  const find = (w: string) => matchMember(w, members)
  const names = (s: string) => s.split(/,|\band\b|&|\+/i).map(find).filter((x): x is Id => !!x)
  // A head count first, so its number is never read as the amount: "split 4", "split into 4", "4 ways", "for 4 people",
  // "4 log", "3360/4".
  const c = t.match(/\bsplit\s+(?:in(?:to)?\s+|between\s+|among\s+)?(\d{1,2})(?:\s*(?:ways?|people|persons?|log))?\b/i)
    ?? t.match(/\b(?:for\s+|between\s+)?(\d{1,2})\s*(?:ways?|people|persons?|pax|log)\b/i)
    ?? t.match(/(?<=\d)\s*\/\s*(\d{1,2})\b/)
  const heads = c ? +c[1] : 0
  if (c) t = t.replace(c[0], ' ')
  const m = t.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|l|lakh)?\b/i)
  if (m) {
    const n = parseFloat(m[1].replace(/,/g, '')) * ({ k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5 }[m[2]?.toLowerCase() ?? ''] ?? 1)
    if (n > 0) out.amount = Math.round(n * 100)
    t = t.replace(m[0], ' ')
  }
  const paid = t.match(/\bpaid by ([\p{L} ]+?)(?=\b(?:split|with|except|for|only|and me)\b|,|$)/iu) ?? t.match(/\b([\p{L}]+) paid\b/iu)
  if (paid) { const id = find(paid[1]); if (id) out.payer = id; t = t.replace(paid[0], ' ') }
  const except = t.match(/\b(?:except|without|not|minus)\s+([\p{L} ,&+]+?)(?=\b(?:split|paid|with|for)\b|$)/iu)
  // "A and B only": walk back from "only" over names and joiners, so the title before them survives.
  const onlyAt = t.search(/\bonly\b/i)
  const before = onlyAt > 0 ? t.slice(0, onlyAt).split(/(\s+|,)/) : []
  let k = before.length
  while (k > 0 && (/^(\s*|,|and|&|\+)$/i.test(before[k - 1]) || find(before[k - 1]))) k--
  const tail = before.slice(k).join('')
  const only = t.match(/\b(?:with|between|split(?: with| between)?|for)\s+([\p{L} ,&+]+?)(?=\b(?:paid|except|only)\b|$)/iu)
    ?? (tail.trim() ? ([tail + 'only', tail] as unknown as RegExpMatchArray) : null)
  if (except) {
    const out_ = new Set(names(except[1]))
    out.people = members.map(x => x.id).filter(id => !out_.has(id))
    t = t.replace(except[0], ' ')
  } else if (only && !/\b(everyone|all|everybody)\b/i.test(only[1])) {
    const ids = names(only[1])
    if (ids.length) { out.people = [...new Set([ME, ...ids])]; t = t.replace(only[0], ' ') }
  }
  if (heads > 1 && !out.people) {
    if (heads === members.length) out.people = members.map(x => x.id)
    else out.count = heads
  }
  t = t.replace(/\b(everyone|everybody|all|split|equally|evenly|only)\b/gi, ' ').replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').replace(/\s+,/g, ',')
  if (t) out.title = t[0].toUpperCase() + t.slice(1)
  const cat = categoryOf(text)
  if (cat) out.cat = cat
  return out
}

// ---------- item split: restaurant bills, Swiggy/Zomato orders ----------
export type Item = { name: string; amount: number; who: Id[] }
/** Each item is split among its people; extras (tax, GST, delivery, tip, discounts) follow each person's item subtotal. */
export function itemSplit(items: Item[], extras: number): { owed: Record<Id, number> } | { error: string } {
  const sub: Record<Id, number> = {}
  for (const it of items) {
    if (it.amount <= 0) continue
    if (!it.who.length) return { error: `Pick who had ${it.name}` }
    const parts = allocate(it.amount, Object.fromEntries(it.who.map(id => [id, 1])))
    for (const id in parts) sub[id] = (sub[id] ?? 0) + parts[id]
  }
  const subtotal = Object.values(sub).reduce((a, b) => a + b, 0)
  if (!subtotal) return { error: 'Add at least one item' }
  if (subtotal + extras <= 0) return { error: 'The discount is bigger than the bill' }
  const ex = extras >= 0 ? allocate(extras, sub) : Object.fromEntries(Object.entries(allocate(-extras, sub)).map(([k, v]) => [k, -v]))
  return { owed: Object.fromEntries(Object.keys(sub).map(id => [id, sub[id] + (ex[id] ?? 0)])) }
}

// ---------- people: one identity each, across every group ----------
/** Who a spot is: their account once they've joined, else the email or phone they were invited by. */
export const personKey = (m: Member) => m.uid ? 'u:' + m.uid : m.email ? 'e:' + m.email.toLowerCase() : m.phone ? 'p:' + m.phone : undefined
export type Friend = { key: string; name: string; email?: string; phone?: string; uid?: string; image?: string; joined: boolean; spots: { g: Group; id: Id }[]; direct?: Group }
/** Everyone you share a group with, once each. `me`: your own account and email, never a friend of yours. */
export function friendsIn(groups: Group[], me?: { id: string; email: string }): Friend[] {
  const by = new Map<string, Friend>()
  for (const g of groups) for (const m of g.members) {
    const k = personKey(m)
    if (m.id === ME || !k || (me && (m.uid === me.id || m.email?.toLowerCase() === me.email.toLowerCase()))) continue
    const f = by.get(k) ?? { key: k, name: m.name, joined: false, spots: [] }
    f.spots.push({ g, id: m.id })
    if (m.joined && !f.joined) { f.joined = true; f.name = m.name } // an account's own name wins over what someone typed
    f.email ||= m.email?.toLowerCase(); f.phone ||= m.phone; f.uid ||= m.uid; f.image ||= m.image
    if (g.kind === 'direct') f.direct = g
    by.set(k, f)
  }
  // A spot still waiting under an email or phone that a friend's account already has is that friend.
  for (const f of by.values()) {
    if (f.joined) continue
    const to = [...by.values()].find(x => x.joined && ((f.email && x.email === f.email) || (f.phone && x.phone === f.phone)))
    if (!to) continue
    to.spots.push(...f.spots); to.direct ||= f.direct
    by.delete(f.key)
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
}
/** A friend by key, or by a bare email (older /f/<email> links) or the email/phone/account a key names. */
export function findFriend(fs: Friend[], k: string): Friend | undefined {
  const [, t, v] = /^([uep]):(.+)$/.exec(k) ?? [, 'e', k.toLowerCase()]
  return fs.find(f => f.key === k) ?? fs.find(f => (t === 'u' ? f.uid : t === 'p' ? f.phone : f.email) === v)
}

// ---------- expenses with friends, outside any group ----------
/** Each pair of friends has its own two-person ledger. An expense with one friend goes there whole. With several
 * friends and no group, it can only be recorded when you paid: each friend's share goes on your ledger with them.
 * (If a friend paid for you and a third person, that third person would owe them on a ledger you're not part of.)
 * Keys: ME, or a friend's key. Returns one expense per friend ledger, keyed the same way. */
export type PairPart = { key: string; amount: number; paid: Record<string, number>; owed: Record<string, number> }
export function friendParts(amount: number, paid: Record<string, number>, owed: Record<string, number>): { parts: PairPart[] } | { error: string } {
  const friends = [...new Set([...Object.keys(paid), ...Object.keys(owed)])].filter(k => k !== ME)
  if (!friends.length) return { error: 'Pick who this is with.' }
  if (friends.length === 1) return { parts: [{ key: friends[0], amount, paid, owed }] }
  if (Object.keys(paid).some(k => k !== ME && paid[k] > 0)) return { error: 'When a friend pays for several people, make it a group so everyone sees the same balances.' }
  const parts = friends.filter(f => (owed[f] ?? 0) > 0).map(f => ({ key: f, amount: owed[f], paid: { [ME]: owed[f] }, owed: { [f]: owed[f] } }))
  return parts.length ? { parts } : { error: 'Nobody else owes anything on this one.' }
}

// ---------- sync: the outbox and edit history ----------
/** A queued server change. `base` = the expense version it started from (null = new, absent = not an expense). */
export type Op = { m: 'PUT' | 'DELETE' | 'POST'; path: string; body?: unknown; base?: number | null; via?: 'ai' }
const expensePath = (p: string) => /\/expenses\/[^/?]+$/.test(p)

/** Queue an op. A newer change to an expense replaces one still waiting (keeping its base, so the server can still
 * spot a stale edit) and moves to the back, after anything it may depend on (a person added since). `busy`: ops[0] is being sent. */
export function enqueue(ops: Op[], op: Op, busy: boolean): Op[] {
  const i = expensePath(op.path) ? ops.findIndex((o, k) => o.path === op.path && !(busy && k === 0)) : -1
  if (i < 0) return [...ops, op]
  const via = op.via ?? ops[i].via // a change folded with an Ask Plico one still says Ask Plico was involved
  return [...ops.slice(0, i), ...ops.slice(i + 1), { ...op, base: ops[i].base, ...(via && { via }) }]
}

/** The server took a change to `path` at `version`: later queued changes to it build on that. */
export const rebase = (ops: Op[], path: string, version: number) => ops.map(o => (o.path === path && 'base' in o ? { ...o, base: version } : o))

/** One version of an expense as the server records it (history snapshots, conflicts). Member ids are server ids. */
export type { Snap }
const day = (d: string) => new Date(d + 'T00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
const list = (xs: string[]) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`

/** What changed between two versions, in words ("amount ₹1,200 → ₹1,500"). */
export function changes(a: Snap, b: Snap, name: (id: Id) => string): string[] {
  const out: string[] = []
  if (a.title !== b.title) out.push(`name “${a.title}” → “${b.title}”`)
  if (a.amount !== b.amount) out.push(`amount ${inr(a.amount)} → ${inr(b.amount)}`)
  if (a.date !== b.date) out.push(`date ${day(a.date)} → ${day(b.date)}`)
  if (a.cat !== b.cat) out.push(`category ${a.cat} → ${b.cat}`)
  const payers = (s: Snap) => s.shares.filter(x => x.paid).map(x => name(x.memberId))
  if (payers(a).join() !== payers(b).join()) out.push(`paid by ${list(payers(a))} → ${list(payers(b))}`)
  const inA = a.shares.filter(x => x.owed).map(x => x.memberId), inB = b.shares.filter(x => x.owed).map(x => x.memberId)
  const added = inB.filter(x => !inA.includes(x)), removed = inA.filter(x => !inB.includes(x))
  if (added.length) out.push(`added ${list(added.map(name))} to the split`)
  if (removed.length) out.push(`took ${list(removed.map(name))} out of the split`)
  if (!added.length && !removed.length && a.amount === b.amount && a.shares.some(x => x.owed !== (b.shares.find(y => y.memberId === x.memberId)?.owed ?? 0)))
    out.push('changed who owes how much')
  if (a.settle && a.pending && !b.pending && !b.rejected) out.push('confirmed the payment arrived')
  if (!a.rejected && b.rejected) out.push('said the payment hasn’t arrived')
  if ((a.receipt ?? null) !== (b.receipt ?? null)) out.push(b.receipt ? (a.receipt ? 'replaced the receipt' : 'added a receipt') : 'removed the receipt')
  if (!!a.repeatNext !== !!b.repeatNext) out.push(b.repeatNext ? 'made it repeat monthly' : 'stopped it repeating')
  return out
}

/** One line for a version on its own: "₹1,200, paid by Asha, split between 3". */
export function summary(s: Snap, name: (id: Id) => string): string {
  const owe = s.shares.filter(x => x.owed)
  const payers = list(s.shares.filter(x => x.paid).map(x => name(x.memberId)))
  return s.settle ? `${inr(s.amount)} from ${payers} to ${list(owe.map(x => name(x.memberId)))}`
    : `${inr(s.amount)}, paid by ${payers}, split between ${owe.length === 1 ? name(owe[0].memberId) : owe.length}`
}

// ---------- the money audit ----------
/** JSON with keys sorted at every level: the same bytes on phone and server, whatever order jsonb stored them in. */
export function canon(v: unknown): string {
  if (v === undefined || v === null) return 'null'
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (typeof v === 'object') return `{${Object.keys(v).sort().filter(k => (v as Record<string, unknown>)[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

/** Change in each member's balance from one version of an expense to the next (null = didn't exist / deleted). Sums to 0. */
export function effectOf(before: Snap | null, after: Snap | null): Record<Id, number> {
  const net = (x: Snap | null) => {
    const out: Record<Id, number> = {}
    if (!x || x.rejected) return out // a payment the payee says never arrived doesn't move balances
    for (const s of x.shares) out[s.memberId] = (out[s.memberId] ?? 0) + s.paid - s.owed
    return out
  }
  const a = net(before), b = net(after), fx: Record<Id, number> = {}
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) { const d = (b[k] ?? 0) - (a[k] ?? 0); if (d) fx[k] = d }
  return fx
}

export type AuditEntry = {
  groupId: string; seq: number; kind: string; expenseId?: string | null; memberId?: string | null; version?: number | null; revertOf?: number | null
  byId?: string | null; byName: string; at: string; before?: unknown; after?: unknown; effect: Record<Id, number>; prevHash: string; hash?: string
  via?: 'ai' | null // made by confirming an Ask Plico card
}
/** What the hash covers: every field of the entry except the hash itself. `via` only when set, so older entries still verify. */
export const auditPayload = (e: AuditEntry) => canon({
  groupId: e.groupId, seq: e.seq, kind: e.kind, expenseId: e.expenseId ?? null, memberId: e.memberId ?? null, version: e.version ?? null,
  revertOf: e.revertOf ?? null, byId: e.byId ?? null, byName: e.byName, at: e.at, before: e.before ?? null, after: e.after ?? null, effect: e.effect,
  ...(e.via && { via: e.via }),
})
export const GENESIS = '0'.repeat(64)

// ---------- crash reports ----------
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/gi // ends in a letters-only domain: not "plico@0.1.0"
// Paths whose next segment is private: an email or a secret token, in app routes (#/…) and API paths alike.
const PRIVATE_PATH = /((?:#\/|\/api\/(?:public\/)?)(?:claim|join|invites|guardian|delete|f|add\/f|u|friends\/code)\/)[^/?#"\s\\]+/g
const PHONE = /\+\d[\d ]{6,16}\d/g // +<country><number>, the form every stored and verified number takes
/** A crash report (or a server log line) as it may leave: every email, phone number and token-bearing path segment removed. */
export const scrub = <T>(x: T): T => JSON.parse(JSON.stringify(x).replace(PRIVATE_PATH, '$1[hidden]').replace(EMAIL, '[email]').replace(PHONE, '[phone]'))
