// An expense before it's saved: who it's with (a group, or friends outside any group), the amounts, and any items.
// The Add screen and Ask Plico both build one; commitDraft() saves it the same way from either.
import { ME, findFriend, friendParts, friendsIn, runRecurring, uid, type Expense, type Id, type SplitMode } from './logic'
import { getState, update } from './store'
import { directWith, targetOf } from './people'
import { markAi } from './sync'
import type { ChatCard } from './schema'

/** Friends outside groups go by their friend key (u:<account>, e:<email> or p:<phone>: see personKey). */
export type Target = { kind: 'group'; groupId: Id } | { kind: 'friends'; people: { key: string; name: string }[] }
/** Amount keys: the group's member ids (ME for you), or ME and friends' keys outside groups. */
export type Draft = {
  target: Target; title: string; cat: string; date: string; amount: number
  paid: Record<string, number>; owed: Record<string, number>
  mode?: SplitMode; input?: Record<string, number>; receipt?: string; repeat?: boolean
}

/** Your ledger with this friend, and their spot in it, if it exists yet. */
const direct = (key: string) => {
  const s = getState(), f = findFriend(friendsIn(s.groups, s.user ?? undefined), key)
  const g = f?.direct
  return g && { g, id: f.spots.find(x => x.g === g)!.id }
}

/** Where the saved expense lives, for going there after. */
export type Saved = { groupId: Id; friend?: string }

/** Save a draft. `via: 'ai'` when it came from an Ask Plico card: the history says so. */
export async function commitDraft(d: Draft, via?: 'ai'): Promise<Saved[]> {
  const put = (gid: Id, e: Omit<Expense, 'id'>) => update(s => {
    const g = s.groups.find(x => x.id === gid)
    if (!g) return
    const day = +e.date.slice(8), id = uid()
    if (via) markAi(id)
    g.expenses.push({ ...e, id, ...(d.repeat && { repeat: { next: nextMonth(e.date), day } }) })
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
    let to = direct(p.key)
    if (!to) {
      const name = d.target.people.find(x => x.key === p.key)?.name ?? p.key.slice(2)
      await directWith(targetOf(p.key), name).catch(() => { throw new Error(navigator.onLine ? 'Couldn’t start your ledger with them. Try again.' : 'The first expense with a friend needs a connection.') })
      to = direct(p.key)
      if (!to) throw new Error('Couldn’t start your ledger with them. Try again.')
    }
    const { g, id } = to
    const key = (k: string) => (k === ME ? ME : id)
    const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [key(k), v]))
    // With several friends, each part is that friend's share; the title says it was part of something bigger.
    const title = r.parts.length > 1 ? `${d.title} (your share of ${r.parts.length + 1})`.slice(0, 120) : d.title
    put(g.id, { ...base, title, amount: p.amount, paid: map(p.paid), owed: map(p.owed), ...(r.parts.length === 1 && { mode: d.mode, input: d.input && map(d.input) }) })
    out.push({ groupId: g.id, friend: p.key })
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
  // Outside groups the card names friends by email: use the key the friend has here (their account, once joined).
  const s = getState(), fs = friendsIn(s.groups, s.user ?? undefined)
  let key = (k: string) => (k === ME ? ME : findFriend(fs, k.toLowerCase())?.key ?? 'e:' + k.toLowerCase())
  if (t.kind === 'group') {
    const g = getState().groups.find(x => x.id === t.groupId)
    if (!g) return { error: 'That group isn’t on this phone yet. Give it a moment to sync, then ask again.' }
    key = k => (k === g.selfId ? ME : k)
    const ids = [...Object.keys(c.paid), ...Object.keys(c.owed)].map(key)
    if (!ids.every(id => g.members.some(m => m.id === id))) return { error: 'People in that group changed. Ask again.' }
  }
  const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [key(k), v]))
  return {
    target: t.kind === 'group' ? { kind: 'group', groupId: t.groupId } : { kind: 'friends', people: t.people.map(p => ({ key: key(p.email), name: p.name })) },
    title: c.title, cat: c.cat, date: c.date, amount: c.amount, paid: map(c.paid), owed: map(c.owed),
    mode: 'exact', input: Object.fromEntries(Object.entries(map(c.owed)).map(([k, v]) => [k, v / 100])), // editable later as exact amounts
  }
}
