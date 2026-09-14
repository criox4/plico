// All money is integer paise. Never floats past the input box.
import type { ThemeId as Theme } from './themes'
export type { Theme }
export type Id = string
export type SplitMode = 'equal' | 'exact' | 'percent' | 'shares'
export type Kind = 'trip' | 'home' | 'couple' | 'friends' | 'family' | 'office'
export type Tone = 'gentle' | 'normal' | 'shameless'

export type Member = {
  id: Id; name: string; upi?: string
  email?: string; phone?: string // invite targets for people without the app
  joined?: boolean // linked to an account
  invited?: boolean // an invite has gone out
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
  pending?: true // settlement waiting for the payee to confirm; doesn't move balances yet
  repeat?: { next: string; day: number } // monthly
}
export type Group = {
  id: Id
  name: string
  kind: Kind
  theme: Theme
  track?: boolean // family-style: show balances, never nag
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
    if (e.pending) continue
    for (const k in e.paid) b[k] = (b[k] ?? 0) + e.paid[k]
    for (const k in e.owed) b[k] = (b[k] ?? 0) - e.owed[k]
  }
  return b
}

/** A settlement waits for the payee unless the payee recorded it or can't confirm (a guest without an account). */
export const needsConfirm = (g: Group, to: Id) => to !== ME && !!g.members.find(m => m.id === to)?.joined

/** Greedy largest-debtor → largest-creditor: at most n-1 payments. */
export function simplify(bal: Record<Id, number>): Transfer[] {
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
