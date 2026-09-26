// An expense before it's saved: who it's with (a group, or friends outside any group), the amounts, and any items.
// The Add screen and Ask Plico both build one; commitDraft() saves it the same way from either.
import { ME, friendParts, runRecurring, uid, type Expense, type Group, type Id, type SplitMode } from './logic'
import { getState, update } from './store'
import { directWith } from './people'
import type { ChatCard } from './schema'

export type Target = { kind: 'group'; groupId: Id } | { kind: 'friends'; people: { email: string; name: string }[] }
/** Amount keys: the group's member ids (ME for you), or ME and friends' emails outside groups. */
export type Draft = {
  target: Target; title: string; cat: string; date: string; amount: number
  paid: Record<string, number>; owed: Record<string, number>
  mode?: SplitMode; input?: Record<string, number>; receipt?: string; repeat?: boolean
}

const direct = (email: string) => getState().groups.find(g => g.kind === 'direct' && g.members.some(m => m.id !== ME && m.email?.toLowerCase() === email))
const memberOf = (g: Group, email: string) => g.members.find(m => m.id !== ME && m.email?.toLowerCase() === email)!.id

/** Where the saved expense lives, for going there after. */
export type Saved = { groupId: Id; friend?: string }

export async function commitDraft(d: Draft): Promise<Saved[]> {
  const put = (gid: Id, e: Omit<Expense, 'id'>) => update(s => {
    const g = s.groups.find(x => x.id === gid)
    if (!g) return
    const day = +e.date.slice(8)
    g.expenses.push({ ...e, id: uid(), ...(d.repeat && { repeat: { next: nextMonth(e.date), day } }) })
    runRecurring(g)
  })
  const base = { title: d.title, cat: d.cat, date: d.date, ...(d.receipt && { receipt: d.receipt }) }
  if (d.target.kind === 'group') {
    put(d.target.groupId, { ...base, amount: d.amount, paid: d.paid, owed: d.owed, mode: d.mode, input: d.input })
    return [{ groupId: d.target.groupId }]
  }
  const r = friendParts(d.amount, d.paid, d.owed)
  if ('error' in r) throw new Error(r.error)
  const out: Saved[] = []
  for (const p of r.parts) {
    const email = p.email.toLowerCase()
    let g = direct(email)
    if (!g) {
      const name = d.target.people.find(x => x.email.toLowerCase() === email)?.name ?? email
      await directWith(email, name).catch(() => { throw new Error(navigator.onLine ? 'Couldn’t start your ledger with them. Try again.' : 'The first expense with a friend needs a connection.') })
      g = direct(email)
      if (!g) throw new Error('Couldn’t start your ledger with them. Try again.')
    }
    const id = memberOf(g, email)
    const key = (k: string) => (k === ME ? ME : id)
    const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [key(k), v]))
    // With several friends, each part is that friend's share; the title says it was part of something bigger.
    const title = r.parts.length > 1 ? `${d.title} (your share of ${r.parts.length + 1})`.slice(0, 120) : d.title
    put(g.id, { ...base, title, amount: p.amount, paid: map(p.paid), owed: map(p.owed), ...(r.parts.length === 1 && { mode: d.mode, input: d.input && map(d.input) }) })
    out.push({ groupId: g.id, friend: email })
  }
  return out
}

const nextMonth = (date: string) => {
  const [y, m, dd] = date.split('-').map(Number)
  const n = new Date(Date.UTC(y, m, 1)), last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 0)).getUTCDate()
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(dd, last)).padStart(2, '0')}`
}

/** A chat card's draft on this phone: the server's member ids map to your copy of the group (you are ME here). */
export function fromCard(c: Extract<ChatCard, { type: 'expense' }>): Draft | { error: string } {
  const t = c.target
  let key = (k: string) => (k === ME ? ME : k.toLowerCase())
  if (t.kind === 'group') {
    const g = getState().groups.find(x => x.id === t.groupId)
    if (!g) return { error: 'That group isn’t on this phone yet. Give it a moment to sync, then ask again.' }
    key = k => (k === g.selfId ? ME : k)
    const ids = [...Object.keys(c.paid), ...Object.keys(c.owed)].map(key)
    if (!ids.every(id => g.members.some(m => m.id === id))) return { error: 'People in that group changed. Ask again.' }
  }
  const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [key(k), v]))
  return {
    target: t.kind === 'group' ? { kind: 'group', groupId: t.groupId } : { kind: 'friends', people: t.people.map(p => ({ ...p, email: p.email.toLowerCase() })) },
    title: c.title, cat: c.cat, date: c.date, amount: c.amount, paid: map(c.paid), owed: map(c.owed),
    mode: 'exact', input: Object.fromEntries(Object.entries(map(c.owed)).map(([k, v]) => [k, v / 100])), // editable later as exact amounts
  }
}
