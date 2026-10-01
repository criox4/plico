// Push notifications, the pure part: who hears about a change, what the push says, and when a person is asleep.
// No database here, so server/push.test.ts can check it all directly.
import { inr } from '../src/logic.ts'

type Share = { memberId: string; paid: number; owed: number }
type Snap = { title: string; amount: number; settle?: boolean; pending?: boolean; rejected?: boolean; verifiedBy?: string | null; shares: Share[] }
export type Change = {
  kind: string; byId?: string | null; byName: string; expenseId?: string | null
  before?: unknown; after?: unknown; effect: Record<string, number>
}
export type Person = { id: string; userId: string | null }
/** One outbox row, before it has a group or a due time. */
export type Push = { userId: string; kind: string; data: Record<string, unknown> }
export type Prefs = { payments: boolean; activity: boolean; reminders: boolean; nudge: boolean; quiet: boolean; amounts: boolean }

export const PREFS: Prefs = { payments: true, activity: true, reminders: true, nudge: true, quiet: true, amounts: true }
export const prefsOf = (v: unknown): Prefs => ({ ...PREFS, ...(v && typeof v === 'object' ? v : {}) })

/** Payments are time-sensitive: sent at once and outside the daily cap (quiet hours still hold them). */
export const URGENT = new Set(['payment.claimed', 'payment.confirmed', 'payment.rejected'])
/** Rows of these kinds for the same person and group are merged into one push. */
export const BATCHED = new Set(['expense.created', 'expense.changed', 'member.joined'])
/** Rows of these kinds wait this long before they're due. The worker drops a reminder whose payment was verified,
 *  rejected or deleted by then (push.ts). */
export const LATER: Record<string, number> = { 'payment.unverified': 864e5 }
export const prefFor = (kind: string): keyof Prefs =>
  kind.startsWith('payment.') ? 'payments' : kind === 'remind' ? 'reminders' : kind === 'nudge' ? 'nudge' : 'activity'

export const BATCH_MS = 2 * 60_000
export const DAILY_CAP = 8

/** Who hears about one audited change. Never the person who made it. */
export function pushesFor(e: Change, people: Person[]): Push[] {
  const user = (mid?: string) => people.find(p => p.id === mid)?.userId ?? null
  const to = (mid: string | undefined, kind: string, data: Record<string, unknown>): Push[] => {
    const u = user(mid)
    return u && u !== e.byId ? [{ userId: u, kind, data }] : []
  }
  const [b, a] = [e.before as Snap | null | undefined, e.after as Snap | null | undefined]
  if (e.kind.startsWith('expense.')) {
    const s = a ?? b
    if (!s?.shares) return []
    if (s.settle) {
      const payer = s.shares.find(x => x.paid > 0)?.memberId, payee = s.shares.find(x => x.owed > 0)?.memberId
      const d = { by: e.byName, amount: s.amount }
      if (e.kind === 'expense.created') {
        // Counted already; the payee is asked whether it arrived, and asked once more a day later if they haven't said.
        if (a?.pending) return [...to(payee, 'payment.claimed', d), ...to(payee, 'payment.unverified', { ...d, expenseId: e.expenseId })]
        return [...to(payer, 'payment.recorded', d), ...to(payee, 'payment.recorded', d)]
      }
      if (e.kind === 'expense.edited' && b?.pending && !a?.pending && !a?.rejected)
        return a?.verifiedBy === 'screenshot' ? to(payee, 'payment.verified', d) : to(payer, 'payment.confirmed', d)
      if (e.kind === 'expense.edited' && !b?.rejected && a?.rejected) return to(payer, 'payment.rejected', d)
      return [] // other settlement changes are in Activity
    }
    if (e.kind === 'expense.created')
      return s.shares.filter(x => x.owed > 0 || x.paid > 0).flatMap(x => to(x.memberId, 'expense.created', { by: e.byName, title: s.title, share: x.owed, delta: e.effect[x.memberId] ?? 0 }))
    const how = e.kind.slice('expense.'.length) // edited | deleted | restored | reverted
    return Object.entries(e.effect).filter(([, v]) => v).flatMap(([mid, v]) => to(mid, 'expense.changed', { by: e.byName, title: s.title, how, delta: v }))
  }
  if (e.kind === 'member.joined') {
    const how = (e.after as { how?: string; addedBy?: string } | null)?.how, addedBy = (e.after as { addedBy?: string } | null)?.addedBy
    // Added by email to an account that already existed: tell them who added them. (Signing up and being linked isn't news.)
    if (how === 'email') return addedBy && e.byId ? [{ userId: e.byId, kind: 'member.added', data: { by: addedBy } }] : []
    return people.filter(p => p.userId && p.userId !== e.byId).map(p => ({ userId: p.userId!, kind: 'member.joined', data: { by: e.byName } }))
  }
  return []
}

type Row = { kind: string; data: Record<string, unknown> }
const money = (p: unknown, show: boolean) => (show ? inr(Math.abs(Number(p) || 0)) : '')
const signed = (p: number) => `${p > 0 ? '+' : '−'}${inr(Math.abs(p))}`
const names = (xs: string[]) => {
  const u = [...new Set(xs)]
  return u.length <= 2 ? u.join(' and ') : `${u.slice(0, 2).join(', ')} and ${u.length - 2} more`
}

/** The text of one push: a person's rows for one group (or one nudge), merged. */
export function compose(rows: Row[], group: string | null, amounts: boolean): { title: string; body: string } {
  const title = group ?? 'Plico'
  const [r] = rows
  const d = r.data as Record<string, string & number>
  const amt = (p: unknown) => money(p, amounts)
  const sp = (p: unknown) => (amounts ? ` ${amt(p)}` : '')
  const where = group ? ` in ${group}` : ''
  if (rows.length === 1) {
    switch (r.kind) {
      case 'payment.claimed': return { title, body: `${d.by} says they paid you${sp(d.amount)}${where}. Did you get it?` }
      case 'payment.unverified': return { title, body: `Did ${d.by}’s${sp(d.amount)} payment arrive? It already counts, so say if it didn’t.` }
      case 'payment.verified': return { title, body: `${d.by} paid you${sp(d.amount)}${where} · checked from their UPI receipt` }
      case 'payment.confirmed': return { title, body: `${d.by} confirmed your${sp(d.amount)} payment. All square on that one.` }
      case 'payment.rejected': return { title, body: `${d.by} says your${sp(d.amount)} payment hasn’t arrived yet.` }
      case 'payment.recorded': return { title, body: `${d.by} recorded a${sp(d.amount)} payment with you.` }
      case 'member.added': return { title, body: `${d.by} added you to ${group ?? 'a group'}.` }
      case 'member.joined': return { title, body: `${d.by} joined.` }
      case 'friend.added': return { title, body: `${d.by} added you as a friend.` }
      case 'remind': return { title, body: `${d.by} sent a reminder: ${amounts ? `${amt(d.amount)} ` : ''}to settle up.` }
      case 'nudge': return { title: 'Plico', body: amounts ? `You owe ${amt(d.amount)} across ${d.groups === 1 ? '1 group' : `${d.groups} groups`}. Settle up in a tap.` : 'You have payments waiting. Settle up in a tap.' }
      case 'expense.created': return { title, body: `${d.by} added “${d.title}”${amounts && d.share ? ` · your share ${amt(d.share)}` : ''}` }
      case 'expense.changed': return { title, body: `${d.by} ${d.how} “${d.title}”${amounts && d.delta ? ` · your balance ${signed(d.delta)}` : ''}` }
    }
  }
  // Several changes in one group: one line that says how many, from whom, and what it did to you.
  const joins = rows.filter(x => x.kind === 'member.joined'), spends = rows.filter(x => x.kind !== 'member.joined')
  const delta = spends.reduce((a, x) => a + (Number(x.data.delta) || 0), 0)
  const by = names(spends.map(x => String(x.data.by)))
  const parts = [
    spends.length ? `${by} ${spends.every(x => x.kind === 'expense.created') ? `added ${spends.length === 1 ? '1 expense' : `${spends.length} expenses`}` : `made ${spends.length === 1 ? '1 change' : `${spends.length} changes`}`}` : '',
    joins.length ? `${names(joins.map(x => String(x.data.by)))} joined` : '',
  ].filter(Boolean)
  return { title, body: parts.join('; ') + (amounts && delta ? ` · your balance ${signed(delta)}` : '') }
}

/** Where a tap on the push opens. */
export const urlFor = (kind: string, groupId: string | null) => (kind === 'nudge' || !groupId ? '#/' : `#/g/${groupId}`)

const zone = (tz?: string | null) => {
  try { if (tz) { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz } } catch { /* not a zone */ }
  return 'Asia/Kolkata'
}
/** Local weekday (0 = Sunday), hour and minute in a time zone. */
export function local(tz: string | null | undefined, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone(tz), weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(at).map(x => [x.type, x.value]))
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday), hour: Number(p.hour), minute: Number(p.minute) }
}
export const QUIET = { from: 22, to: 8 }
/** When quiet hours end, or null if it isn't quiet now. */
export function quietUntil(tz: string | null | undefined, at = new Date()): Date | null {
  const { hour, minute } = local(tz, at)
  if (hour < QUIET.from && hour >= QUIET.to) return null
  const hours = (QUIET.to - hour + 24) % 24
  return new Date(at.getTime() + (hours * 60 - minute) * 60_000)
}
