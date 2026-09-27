// Ask Plico's tools. Every tool works on a World: the signed-in person's own groups, loaded by chat.ts before the
// model runs. The model can name groups and people, but only inside this world: nothing else is reachable from here.
// Money is computed and written out here, so the model never does arithmetic. Drafts only describe an action; the
// app performs it when the person taps.
import { ME, allocate, balances, friendParts, inr, itemSplit, pairwise, simplify, type Expense, type Group } from '../src/logic.ts'

export type WMember = { id: string; name: string; email: string | null; joined: boolean }
export type WGroup = Group & { meId: string; people: WMember[]; kind: string }
export type WEvent = { groupId: string; kind: string; byName: string; viaAi?: boolean; at: string; title: string | null; amount: number | null; effect: Record<string, number> }
/** A receipt the person attached, as read (paise). */
export type Receipt = { title: string; amount: number | null; items: { name: string; amount: number }[]; extras: number }
/** Sorts receipt items into the person's rules ("non-veg food"). rule = index, or null when none fits; sure = confident. */
export type Classify = (items: string[], rules: string[]) => Promise<{ rule: number | null; sure: boolean }[]>
export type WDeleted = { id: string; groupId: string; title: string; amount: number; date: string; deletedAt: string; settle: boolean }
export type World = { me: { name: string; email: string }; today: string; groups: WGroup[]; events: WEvent[]; deleted?: WDeleted[]; receipt?: Receipt; classify?: Classify }

/** Text other people typed (titles, names) is data: strip control and direction characters, cap the length. */
export const clean = (s: unknown, max = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const rs = (p: number) => inr(p)
const signed = (p: number) => (p > 0 ? `+${inr(p)}` : p < 0 ? `−${inr(p)}` : inr(0))
const gname = (g: WGroup) => clean(g.kind === 'direct' ? `You and ${g.people.find(p => p.id !== g.meId)?.name ?? 'a friend'}` : g.name, 60)
const who = (g: WGroup, id: string) => (id === g.meId ? 'you' : clean(g.people.find(p => p.id === id)?.name ?? 'someone', 40))
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N} ]/gu, '').trim()

type Found<T> = { ok: T } | { error: string }
/** Resolve a name the person used: exact, then prefix, then contains. Ambiguity is reported, never guessed. */
function pick<T>(items: T[], name: string, label: (t: T) => string, what: string): Found<T> {
  const n = norm(name)
  if (!n) return { error: `Which ${what}?` }
  for (const test of [(l: string) => l === n, (l: string) => l.startsWith(n), (l: string) => l.includes(n)]) {
    const hits = items.filter(t => test(norm(label(t))))
    if (hits.length === 1) return { ok: hits[0] }
    if (hits.length > 1) return { error: `More than one ${what} matches “${clean(name, 40)}”: ${hits.slice(0, 6).map(label).map(x => clean(x, 40)).join(', ')}. Ask which one.` }
  }
  return { error: what === 'group' ? `No group called “${clean(name, 40)}” in your groups. Your groups: ${items.slice(0, 12).map(label).map(x => clean(x, 40)).join(', ')}.` : `No ${what} called “${clean(name, 40)}”.` }
}
const findGroup = (w: World, name: string) => pick(w.groups, name, gname, 'group')
const isMe = (s: string) => /^(me|i|myself|you|self)$/i.test(s.trim())
const findPerson = (g: WGroup, name: string) => (isMe(name) ? { ok: g.people.find(p => p.id === g.meId)! } : pick(g.people.filter(p => p.id !== g.meId), name, p => p.name, `person in ${gname(g)}`))

/** Friends across groups, by email, with the pairwise balance (positive: they owe you). */
function friends(w: World) {
  const by = new Map<string, { name: string; n: number; groups: string[] }>()
  for (const g of w.groups) for (const p of g.people) {
    if (p.id === g.meId || !p.email) continue
    const f = by.get(p.email) ?? { name: p.name, n: 0, groups: [] }
    f.n += pairwise(g, g.meId, p.id); f.groups.push(gname(g))
    by.set(p.email, f)
  }
  return [...by.values()]
}
const live = (e: Expense) => !e.pending && !e.rejected

// ---------- the tools ----------
type Args = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined)
const day = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)

export type Target = { kind: 'group'; groupId: string; group: string } | { kind: 'friends'; people: { email: string; name: string }[] }
/** Amount keys: member ids for a group; "me" and friends' emails outside groups. `names` labels every key. */
export type Card =
  | { type: 'expense'; target: Target; title: string; cat: string; date: string; amount: number; paid: Record<string, number>; owed: Record<string, number>
      names: Record<string, string>; items?: { name: string; amount: number; who: string[]; unsure?: boolean }[]; extras?: number; summary: string }
  | { type: 'settle'; groupId: string; group: string; from: string; to: string; amount: number; summary: string }
  | { type: 'remind'; groupId: string; group: string; memberId: string; name: string; amount: number; summary: string }
  /** Record a payment. `confirm`: the payee has to confirm it arrived before it counts. */
  | { type: 'pay'; groupId: string; group: string; from: string; to: string; amount: number; confirm: boolean; summary: string }
  /** The person is the payee of a payment waiting for them: Got it / Not yet. */
  | { type: 'confirm'; groupId: string; group: string; expenseId: string; amount: number; from: string; summary: string }
  /** Before → after of one expense, at the version it was drafted from. */
  | { type: 'edit'; groupId: string; group: string; expenseId: string; version: number; before: Shot; after: Shot; names: Record<string, string>; changes: string[]; summary: string }
  | { type: 'delete'; groupId: string; group: string; expenseId: string; version: number; title: string; amount: number; summary: string }
  | { type: 'restore'; groupId: string; group: string; expenseId: string; title: string; amount: number; summary: string }
/** The parts of an expense an edit can change. Amount keys are the group's member ids. */
export type Shot = { title: string; cat: string; date: string; amount: number; paid: Record<string, number>; owed: Record<string, number> }
export type ToolOut = { result: unknown; card?: Card }
type Out = ToolOut | Promise<ToolOut>

const TOOLS: Record<string, (w: World, a: Args) => Out> = {
  list_groups: w => ({ result: w.groups.map(g => {
    const n = balances(g)[g.meId] ?? 0
    return { group: gname(g), kind: g.kind === 'direct' ? 'friend (outside groups)' : g.kind, people: g.people.length, your_balance: signed(n), meaning: n > 0 ? 'you are owed' : n < 0 ? 'you owe' : 'settled', tracking_only: !!g.track }
  }) }),

  balances: (w, a) => {
    if (str(a.group)) {
      const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }
      const g = f.ok, bal = balances(g)
      return { result: { group: gname(g), your_balance: signed(bal[g.meId] ?? 0), settle_plan: simplify(bal).map(d => ({ from: who(g, d.from), to: who(g, d.to), amount: rs(d.amount) })) } }
    }
    const fr = friends(w).filter(f => f.n).sort((x, y) => Math.abs(y.n) - Math.abs(x.n))
    const nets = w.groups.filter(g => !g.track).map(g => balances(g)[g.meId] ?? 0)
    return { result: {
      overall: signed(nets.reduce((s, n) => s + n, 0)),
      to_collect: rs(nets.reduce((s, n) => s + Math.max(n, 0), 0)), to_pay: rs(nets.reduce((s, n) => s + Math.max(-n, 0), 0)),
      people: fr.slice(0, 30).map(f => ({ name: clean(f.name, 40), balance: signed(f.n), meaning: f.n > 0 ? 'owes you' : 'you owe them', across: f.groups })),
    } }
  },

  find_expenses: (w, a) => {
    // Models fill every optional field: 0 means no limit, and a guessed category that finds nothing is dropped below.
    const text = norm(str(a.text)), from = day(a.from), to = day(a.to), min = num(a.min_amount) || undefined, max = num(a.max_amount) || undefined
    let cat = str(a.category)
    let gs = w.groups
    if (str(a.group)) { const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }; gs = [f.ok] }
    const search = () => gs.flatMap(g => {
      let person: string | null = null
      if (str(a.person)) { const p = findPerson(g, str(a.person)); if ('error' in p) return []; person = p.ok.id }
      return g.expenses.filter(e => !e.settle
        && (!text || norm(e.title).includes(text)) && (!cat || e.cat === cat) && (!from || e.date >= from) && (!to || e.date <= to)
        && (min === undefined || e.amount >= min * 100) && (max === undefined || e.amount <= max * 100)
        && (!person || e.paid[person] || e.owed[person])).map(e => ({ g, e }))
    }).sort((x, y) => y.e.date.localeCompare(x.e.date))
    let rows = search(), anyCat = false
    if (!rows.length && cat) { cat = ''; rows = search(); anyCat = rows.length > 0 }
    const limit = Math.min(Math.max(num(a.limit) ?? 15, 1), 25)
    return { result: {
      count: rows.length, total: rs(rows.reduce((s, r) => s + r.e.amount, 0)), your_share_total: rs(rows.reduce((s, r) => s + (r.e.owed[r.g.meId] ?? 0), 0)),
      expenses: rows.slice(0, limit).map(({ g, e }) => ({
        id: e.id, date: e.date, title: clean(e.title), group: gname(g), category: e.cat, amount: rs(e.amount),
        paid_by: Object.keys(e.paid).map(id => who(g, id)).join(', '), your_share: rs(e.owed[g.meId] ?? 0),
      })),
      ...(rows.length > limit && { note: `Showing the latest ${limit} of ${rows.length}.` }),
      ...(anyCat && { category_note: 'Nothing matched that category, so these are from any category.' }),
    } }
  },

  spending: (w, a) => {
    const by = (['category', 'month', 'group', 'person'] as const).find(x => x === a.by) ?? 'category'
    const from = day(a.from), to = day(a.to)
    let gs = w.groups
    if (str(a.group)) { const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }; gs = [f.ok] }
    const sums = new Map<string, { yours: number; total: number }>()
    for (const g of gs) for (const e of g.expenses) {
      if (e.settle || !live(e) || (from && e.date < from) || (to && e.date > to)) continue
      const keys = by === 'category' ? [e.cat] : by === 'month' ? [e.date.slice(0, 7)] : by === 'group' ? [gname(g)] : Object.keys(e.paid).map(id => `paid by ${who(g, id)}`)
      for (const k of keys) { const s = sums.get(k) ?? { yours: 0, total: 0 }; s.yours += e.owed[g.meId] ?? 0; s.total += e.amount; sums.set(k, s) }
    }
    const list = [...sums].sort((x, y) => y[1].yours - x[1].yours)
    return { result: { by, from: from ?? 'the beginning', to: to ?? w.today, your_share_total: rs(list.reduce((s, [, v]) => s + v.yours, 0)),
      rows: list.slice(0, 24).map(([k, v]) => ({ [by]: k, your_share: rs(v.yours), group_total: rs(v.total) })) } }
  },

  activity: (w, a) => {
    const days = Math.min(Math.max(num(a.days) ?? 14, 1), 90)
    const since = new Date(Date.parse(w.today) - days * 864e5).toISOString()
    let evs = w.events.filter(e => e.at >= since)
    if (str(a.group)) { const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }; evs = evs.filter(e => e.groupId === f.ok.id) }
    const names = new Map(w.groups.map(g => [g.id, g]))
    return { result: { days, entries: evs.slice(0, 30).map(e => {
      const g = names.get(e.groupId)!
      const mine = e.effect[g.meId] ?? 0
      return { when: e.at.slice(0, 16).replace('T', ' '), group: gname(g), by: clean(e.byName, 40) + (e.viaAi ? ' (via Ask Plico)' : ''), what: e.kind.replace('.', ' '), title: e.title ? clean(e.title) : null, amount: e.amount ? rs(e.amount) : null, your_balance_change: mine ? signed(mine) : null }
    }) } }
  },

  draft_expense: (w, a) => draftExpense(w, a),

  draft_settlement: (w, a) => {
    const gs = str(a.group) ? (() => { const f = findGroup(w, str(a.group)); return 'error' in f ? f : { ok: [f.ok] } })() : { ok: w.groups }
    if ('error' in gs) return { result: gs }
    for (const g of gs.ok) {
      if (g.track) continue
      const p = findPerson(g, str(a.person)); if ('error' in p) continue
      const d = simplify(balances(g)).find(t => (t.from === g.meId && t.to === p.ok.id) || (t.to === g.meId && t.from === p.ok.id))
      if (!d) continue
      const summary = d.from === g.meId ? `You pay ${who(g, d.to)} ${rs(d.amount)} in ${gname(g)}.` : `${who(g, d.from)} pays you ${rs(d.amount)} in ${gname(g)}.`
      return { result: { drafted: summary, next: 'Shown as a card that opens the settle-up screen.' }, card: { type: 'settle', groupId: g.id, group: gname(g), from: d.from, to: d.to, amount: d.amount, summary } }
    }
    return { result: { error: `Nothing to settle between you and “${clean(a.person, 40)}”${str(a.group) ? ' in that group' : ''}.` } }
  },

  draft_reminder: (w, a) => {
    const gs = str(a.group) ? (() => { const f = findGroup(w, str(a.group)); return 'error' in f ? f : { ok: [f.ok] } })() : { ok: w.groups }
    if ('error' in gs) return { result: gs }
    for (const g of gs.ok) {
      if (g.track) continue
      const p = findPerson(g, str(a.person)); if ('error' in p || p.ok.id === g.meId) continue
      const d = simplify(balances(g)).find(t => t.from === p.ok.id && t.to === g.meId)
      if (!d) continue
      const summary = `Remind ${who(g, d.from)} about ${rs(d.amount)} in ${gname(g)}.`
      return { result: { drafted: summary, next: 'Shown as a card with a Send button.' }, card: { type: 'remind', groupId: g.id, group: gname(g), memberId: d.from, name: who(g, d.from), amount: d.amount, summary } }
    }
    return { result: { error: `“${clean(a.person, 40)}” doesn’t owe you anything${str(a.group) ? ' in that group' : ''}.` } }
  },
}

/** Friends across the person's groups, by name, for expenses outside any group. */
function findFriend(w: World, name: string) {
  const byEmail = new Map<string, { email: string; name: string }>()
  for (const g of w.groups) for (const p of g.people) if (p.id !== g.meId && p.email) byEmail.set(p.email, { email: p.email, name: p.name })
  return pick([...byEmail.values()], name, f => f.name, 'friend')
}

/** Who an expense is between: a group's members, or you and some friends. Keys and labels for the amounts. */
type Party = { target: Target; keys: string[]; me: string; label: (k: string) => string; find: (name: string) => Found<string> }
function partyOf(w: World, a: Args): Found<Party> {
  const withNames = Array.isArray(a.with) ? a.with.map(String).filter(Boolean).slice(0, 20) : []
  if (str(a.group) && withNames.length) return { error: 'Use a group or friends, not both.' }
  if (withNames.length) {
    const people: { email: string; name: string }[] = []
    for (const n of withNames) { const f = findFriend(w, n); if ('error' in f) return f; if (!people.some(p => p.email === f.ok.email)) people.push(f.ok) }
    const label = (k: string) => (k === ME ? 'you' : clean(people.find(p => p.email === k)?.name ?? k, 40))
    const find = (n: string): Found<string> => {
      if (isMe(n)) return { ok: ME }
      const p = pick(people, n, x => x.name, 'friend in this expense')
      return 'error' in p ? p : { ok: p.ok.email }
    }
    return { ok: { target: { kind: 'friends', people }, keys: [ME, ...people.map(p => p.email)], me: ME, label, find } }
  }
  const f = findGroup(w, str(a.group)); if ('error' in f) return f
  const g = f.ok
  return { ok: {
    target: { kind: 'group', groupId: g.id, group: gname(g) }, keys: g.people.map(p => p.id), me: g.meId, label: id => who(g, id),
    find: n => { const p = findPerson(g, n); return 'error' in p ? p : { ok: p.ok.id } },
  } }
}

async function draftExpense(w: World, a: Args): Promise<ToolOut> {
  const pf = partyOf(w, a); if ('error' in pf) return { result: pf }
  const P = pf.ok
  const payer = str(a.paid_by) ? P.find(str(a.paid_by)) : { ok: P.me }
  if ('error' in payer) return { result: payer }
  const among: string[] = []
  for (const n of Array.isArray(a.split_between) ? a.split_between.map(String).slice(0, 50) : []) { const k = P.find(n); if ('error' in k) return { result: k }; among.push(k.ok) }
  const everyone = [...new Set(among.length ? among : P.keys)]
  const title = clean(a.title, 60) || w.receipt?.title && clean(w.receipt.title, 60) || 'Expense'
  const cat = ['food', 'groceries', 'stay', 'transport', 'drinks', 'fun', 'rent', 'bills', 'help', 'other'].includes(str(a.category)) ? str(a.category) : 'other'
  const date = day(a.date) ?? w.today
  let owed: Record<string, number>, amount: number
  let items: NonNullable<Extract<Card, { type: 'expense' }>['items']> | undefined
  let fallback = everyone
  const rules = Array.isArray(a.item_rules) ? (a.item_rules as { rule?: unknown; people?: unknown }[]).slice(0, 8) : []
  const named = Array.isArray(a.item_assignments) ? a.item_assignments : []
  if (rules.length || named.length) { // models often send empty lists for optional arguments
    const r = w.receipt
    if (!r?.items.length) return { result: { error: 'There’s no receipt with items to split. Ask the person to attach one, or split the total.' } }
    const ruleKeys: string[][] = []
    for (const rule of rules) {
      const ks: string[] = []
      for (const n of Array.isArray(rule.people) ? rule.people.map(String) : []) { const k = P.find(n); if ('error' in k) return { result: k }; ks.push(k.ok) }
      ruleKeys.push([...new Set(ks)])
    }
    // Items the rules don't settle go to `leftover_people` (default: everyone in the expense) and are marked for a look.
    const rest: string[] = []
    for (const n of Array.isArray(a.leftover_people) ? a.leftover_people.map(String) : []) { const k = P.find(n); if ('error' in k) return { result: k }; rest.push(k.ok) }
    if (rest.length) fallback = [...new Set(rest)]
    const explicit = new Map<number, string[]>()
    for (const x of Array.isArray(a.item_assignments) ? (a.item_assignments as { item?: unknown; people?: unknown }[]) : []) {
      const i = num(x.item); if (i === undefined || !r.items[i]) continue
      const ks: string[] = []
      for (const n of Array.isArray(x.people) ? x.people.map(String) : []) { const k = P.find(n); if ('error' in k) return { result: k }; ks.push(k.ok) }
      explicit.set(i, [...new Set(ks)])
    }
    const sorted = rules.length && w.classify ? await w.classify(r.items.map(i => i.name), rules.map(x => clean(x.rule, 80))) : r.items.map(() => ({ rule: null, sure: false }))
    items = r.items.map((it, i) => {
      if (explicit.has(i)) return { name: clean(it.name, 60), amount: it.amount, who: explicit.get(i)! }
      const m = sorted[i]
      const who = m.rule !== null && ruleKeys[m.rule]?.length ? ruleKeys[m.rule] : fallback
      return { name: clean(it.name, 60), amount: it.amount, who, ...(!(m.rule !== null && m.sure) && { unsure: true }) }
    })
    const res = itemSplit(items.map(i => ({ name: i.name, amount: i.amount, who: i.who })), r.extras)
    if ('error' in res) return { result: { error: res.error } }
    owed = res.owed; amount = Object.values(owed).reduce((x, y) => x + y, 0)
  } else {
    amount = Math.round((num(a.amount) ?? (w.receipt?.amount ? w.receipt.amount / 100 : 0)) * 100)
    if (amount < 100 || amount > 1e9) return { result: { error: 'Need an amount between ₹1 and ₹1,00,00,000.' } }
    owed = allocate(amount, Object.fromEntries(everyone.map(k => [k, 1])))
  }
  const paid = { [payer.ok]: amount }
  if (P.target.kind === 'friends') { const fp = friendParts(amount, paid, owed); if ('error' in fp) return { result: fp } }
  const names = Object.fromEntries(P.keys.map(k => [k, k === P.me ? 'You' : P.label(k)]))
  const where = P.target.kind === 'group' ? `in ${P.target.group}` : `with ${P.target.people.map(p => clean(p.name, 40)).join(', ')} (no group)`
  const shares = Object.entries(owed).filter(([, v]) => v).map(([k, v]) => `${P.label(k)} ${rs(v)}`).join(', ')
  const unsure = items?.filter(i => i.unsure).map(i => i.name) ?? []
  const summary = `${title}: ${rs(amount)} ${where}, paid by ${P.label(payer.ok)}. ${items ? 'By item' : 'Split equally'}: ${shares}.`
  return {
    result: { drafted: summary, ...(unsure.length && { check_with_person: `Not sure who had: ${unsure.join(', ')}. They were split between ${fallback.map(P.label).join(', ')}.` }),
      next: 'Shown to the person as a card they can adjust and then Add. Nothing is saved until they tap it.' },
    card: { type: 'expense', target: P.target, title, cat, date, amount, paid, owed, names, ...(items && { items, extras: w.receipt!.extras }), summary },
  }
}

// ---------- explaining, and changing what's already there ----------
const CATEGORIES = ['food', 'groceries', 'stay', 'transport', 'drinks', 'fun', 'rent', 'bills', 'help', 'other']
/** Where one person shows up: every group you share with them (matched by email, so the same friend across groups). */
function spotsOf(w: World, name: string, group?: string): Found<{ name: string; spots: { g: WGroup; id: string }[] }> {
  let gs = w.groups
  if (group) { const f = findGroup(w, group); if ('error' in f) return f; gs = [f.ok] }
  if (gs.length === 1) { const p = findPerson(gs[0], name); if ('error' in p) return p; if (p.ok.id === gs[0].meId) return { error: 'That’s you.' }; return { ok: { name: p.ok.name, spots: [{ g: gs[0], id: p.ok.id }] } } }
  const f = findFriend(w, name); if ('error' in f) return f
  const spots = gs.flatMap(g => g.people.filter(p => p.id !== g.meId && p.email === f.ok.email).map(p => ({ g, id: p.id })))
  return { ok: { name: f.ok.name, spots } }
}
/** One expense's share of what b owes a (from the expense itself; positive: b owes a). */
const pairOf = (e: Expense, a: string, b: string) => (e.pending || e.rejected || !e.amount ? 0 : Math.round(((e.owed[b] ?? 0) * (e.paid[a] ?? 0) - (e.owed[a] ?? 0) * (e.paid[b] ?? 0)) / e.amount))
const findExpense = (w: World, id: string): Found<{ g: WGroup; e: Expense }> => {
  for (const g of w.groups) { const e = g.expenses.find(x => x.id === id); if (e) return { ok: { g, e } } }
  return { error: 'No expense with that id in your groups. Search with find_expenses and use the id it returns.' }
}
const shot = (e: Expense): Shot => ({ title: e.title, cat: e.cat, date: e.date, amount: e.amount, paid: { ...e.paid }, owed: { ...e.owed } })
const nice = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const describe = (g: WGroup, o: Record<string, number>) => Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${who(g, k)} ${rs(v)}`).join(', ')

const MORE: Record<string, (w: World, a: Args) => Out> = {
  explain_balance: (w, a) => {
    const f = spotsOf(w, str(a.person), str(a.group) || undefined); if ('error' in f) return { result: f }
    const groups = f.ok.spots.filter(x => !x.g.track).map(({ g, id }) => {
      const rows = g.expenses.map(e => ({ e, n: pairOf(e, g.meId, id) })).filter(r => r.n)
      const total = rows.reduce((t, r) => t + r.n, 0)
      const plan = simplify(balances(g)).find(t => (t.from === id && t.to === g.meId) || (t.from === g.meId && t.to === id))
      const planN = plan ? (plan.to === g.meId ? plan.amount : -plan.amount) : 0
      return {
        group: gname(g), from_expenses: signed(total), meaning: total > 0 ? `${clean(f.ok.name, 40)} owes you` : total < 0 ? `you owe ${clean(f.ok.name, 40)}` : 'even',
        ...(planN !== total && { settle_plan: signed(planN), why_different: 'The group’s settle-up plan combines everyone’s debts into the fewest payments, so it can ask this person for a different amount than their share of what you paid. Each person’s total in the group is the same either way.' }),
        biggest: rows.sort((x, y) => Math.abs(y.n) - Math.abs(x.n)).slice(0, 12).map(r => ({
          date: r.e.date, title: clean(r.e.title), kind: r.e.settle ? 'payment' : 'expense', amount: rs(r.e.amount), paid_by: Object.keys(r.e.paid).map(k => who(g, k)).join(', '),
          effect: r.n > 0 ? `${clean(f.ok.name, 40)} owes you ${rs(r.n)} more` : `you owe ${clean(f.ok.name, 40)} ${rs(-r.n)} more (or they’re owed less)`,
        })),
        ...(rows.length > 12 && { note: `The ${rows.length - 12} smaller entries aren’t listed.` }),
      }
    })
    const total = f.ok.spots.filter(x => !x.g.track).reduce((t, { g, id }) => t + g.expenses.reduce((u, e) => u + pairOf(e, g.meId, id), 0), 0)
    return { result: { person: clean(f.ok.name, 40), overall: signed(total), overall_meaning: total > 0 ? 'they owe you' : total < 0 ? 'you owe them' : 'even', groups } }
  },

  pending: w => {
    const rows = w.groups.flatMap(g => g.expenses.filter(e => e.settle && (e.pending || e.rejected)).map(e => {
      const from = Object.keys(e.paid)[0], to = Object.keys(e.owed)[0]
      const what = e.rejected ? (from === g.meId ? `${who(g, to)} says your ${rs(e.amount)} hasn’t arrived` : `you said ${who(g, from)}’s ${rs(e.amount)} hasn’t arrived`)
        : to === g.meId ? `${who(g, from)} says they paid you ${rs(e.amount)}: waiting for you to confirm` : from === g.meId ? `waiting for ${who(g, to)} to confirm your ${rs(e.amount)}` : `${who(g, from)} → ${who(g, to)} ${rs(e.amount)}, waiting for ${who(g, to)}`
      return { id: e.id, group: gname(g), date: e.date, what, you_can_confirm: !e.rejected && to === g.meId }
    }))
    return { result: rows.length ? { payments: rows } : { payments: [], note: 'No payments are waiting on anyone.' } }
  },

  confirm_payment: (w, a) => {
    const all = w.groups.flatMap(g => g.expenses.filter(e => e.settle && e.pending && !e.rejected && Object.keys(e.owed)[0] === g.meId).map(e => ({ g, e })))
    let hits = all
    if (str(a.expense_id)) hits = hits.filter(x => x.e.id === str(a.expense_id))
    if (str(a.group)) { const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }; hits = hits.filter(x => x.g.id === f.ok.id) }
    if (str(a.person)) hits = hits.filter(x => norm(who(x.g, Object.keys(x.e.paid)[0])).includes(norm(str(a.person))))
    if (num(a.amount)) hits = hits.filter(x => x.e.amount === Math.round(num(a.amount)! * 100))
    if (!hits.length) return { result: { error: all.length ? 'No payment waiting for you matches that. Use pending to list them.' : 'No payments are waiting for you to confirm.' } }
    if (hits.length > 1) return { result: { error: 'More than one payment matches. Ask which.', payments: hits.slice(0, 8).map(({ g, e }) => ({ id: e.id, group: gname(g), from: who(g, Object.keys(e.paid)[0]), amount: rs(e.amount), date: e.date })) } }
    const { g, e } = hits[0], from = Object.keys(e.paid)[0]
    const summary = `Did ${who(g, from)}’s ${rs(e.amount)} in ${gname(g)} arrive? Check your UPI app first.`
    return { result: { drafted: summary, next: 'Shown as a card with Got it and Not yet.' }, card: { type: 'confirm', groupId: g.id, group: gname(g), expenseId: e.id, amount: e.amount, from: who(g, from), summary } }
  },

  mark_paid: (w, a) => {
    const f = spotsOf(w, str(a.person), str(a.group) || undefined); if ('error' in f) return { result: f }
    const dir = a.direction === 'i_paid_them' ? 'out' : a.direction === 'they_paid_me' ? 'in' : null
    const want = num(a.amount) ? Math.round(num(a.amount)! * 100) : undefined // 0: not given
    if (want !== undefined && (want < 100 || want > 1e9)) return { result: { error: 'Need an amount between ₹1 and ₹1,00,00,000.' } }
    const live = f.ok.spots.filter(x => !x.g.track)
    if (!live.length) return { result: { error: `You don’t share a group that tracks balances with ${clean(f.ok.name, 40)}.` } }
    // What the settle-up plan says between you two in each group (positive: they pay you).
    const owing = live.map(({ g, id }) => {
      const t = simplify(balances(g)).find(x => (x.from === id && x.to === g.meId) || (x.from === g.meId && x.to === id))
      return { g, id, n: t ? (t.to === g.meId ? t.amount : -t.amount) : 0 }
    }).filter(x => x.n && (!dir || (dir === 'in') === (x.n > 0)))
    let pickd = owing.length === 1 ? owing[0] : undefined
    if (!pickd && live.length === 1 && dir && want) pickd = { ...live[0], n: 0 }
    if (!pickd) return { result: owing.length
      ? { error: 'Payments are open in more than one group. Ask which group (or record one per group).', open: owing.map(x => ({ group: gname(x.g), plan: x.n > 0 ? `${clean(f.ok.name, 40)} pays you ${rs(x.n)}` : `you pay ${clean(f.ok.name, 40)} ${rs(-x.n)}` })) }
      : { error: `Nothing is owed between you and ${clean(f.ok.name, 40)}${dir ? ' that way' : ''}. To record a payment anyway, give the group, the direction and the amount.` } }
    const { g, id, n } = pickd
    const inward = dir ? dir === 'in' : n > 0
    const amount = want ?? Math.abs(n)
    const [from, to] = inward ? [id, g.meId] : [g.meId, id]
    const confirm = !inward && !!g.people.find(p => p.id === id)?.joined
    const summary = `${inward ? `${who(g, id)} paid you` : `You paid ${who(g, id)}`} ${rs(amount)} in ${gname(g)}.${confirm ? ` It counts once ${who(g, id)} confirms it arrived.` : ''}`
    return { result: { drafted: summary, ...(n && amount !== Math.abs(n) && { note: `The settle-up plan says ${rs(Math.abs(n))}; this records ${rs(amount)}.` }), next: 'Shown as a card; recorded only when the person taps Record.' },
      card: { type: 'pay', groupId: g.id, group: gname(g), from, to, amount, confirm, summary } }
  },

  edit_expense: (w, a) => {
    const f = findExpense(w, str(a.expense_id)); if ('error' in f) return { result: f }
    const { g, e } = f.ok
    if (e.settle) return { result: { error: 'That’s a payment. To fix it, delete it and record the right one with mark_paid.' } }
    const before = shot(e), after = shot(e)
    if (str(a.title)) after.title = clean(a.title, 60)
    if (CATEGORIES.includes(str(a.category))) after.cat = str(a.category)
    if (day(a.date)) after.date = day(a.date)!
    if (num(a.amount)) { // 0: not given
      after.amount = Math.round(num(a.amount)! * 100)
      if (after.amount < 100 || after.amount > 1e9) return { result: { error: 'Need an amount between ₹1 and ₹1,00,00,000.' } }
    }
    const among: string[] = []
    for (const n of Array.isArray(a.split_between) ? a.split_between.map(String).slice(0, 50) : []) { const p = findPerson(g, n); if ('error' in p) return { result: p }; among.push(p.ok.id) }
    // Shares: an equal split when named, otherwise the old shares scaled to the new amount.
    after.owed = among.length ? allocate(after.amount, Object.fromEntries([...new Set(among)].map(k => [k, 1]))) : after.amount !== before.amount ? allocate(after.amount, before.owed) : before.owed
    if (str(a.paid_by)) { const p = findPerson(g, str(a.paid_by)); if ('error' in p) return { result: p }; after.paid = { [p.ok.id]: after.amount } }
    else if (after.amount !== before.amount) after.paid = allocate(after.amount, before.paid)
    const changes = [
      before.title !== after.title && `name “${clean(before.title)}” → “${after.title}”`,
      before.amount !== after.amount && `amount ${rs(before.amount)} → ${rs(after.amount)}`,
      before.date !== after.date && `date ${nice(before.date)} → ${nice(after.date)}`,
      before.cat !== after.cat && `category ${before.cat} → ${after.cat}`,
      JSON.stringify(before.paid) !== JSON.stringify(after.paid) && `paid by ${describe(g, before.paid)} → ${describe(g, after.paid)}`,
      JSON.stringify(before.owed) !== JSON.stringify(after.owed) && `shares ${describe(g, before.owed)} → ${describe(g, after.owed)}`,
    ].filter(Boolean) as string[]
    if (!changes.length) return { result: { error: 'That wouldn’t change anything.' } }
    const summary = `Change “${clean(before.title)}” in ${gname(g)}: ${changes.join('; ')}.`
    const names = Object.fromEntries(g.people.map(p => [p.id, p.id === g.meId ? 'You' : clean(p.name, 40)]))
    return { result: { drafted: summary, next: 'Shown as a before-and-after card; changed only when the person taps Save.' },
      card: { type: 'edit', groupId: g.id, group: gname(g), expenseId: e.id, version: e.v ?? 0, before, after, names, changes, summary } }
  },

  delete_expense: (w, a) => {
    const f = findExpense(w, str(a.expense_id)); if ('error' in f) return { result: f }
    const { g, e } = f.ok
    const summary = `Delete ${e.settle ? 'the payment' : `“${clean(e.title)}”`} (${rs(e.amount)}, ${nice(e.date)}) from ${gname(g)}? It can be restored later.`
    return { result: { drafted: summary, next: 'Shown as a red card; deleted only when the person taps Delete.' },
      card: { type: 'delete', groupId: g.id, group: gname(g), expenseId: e.id, version: e.v ?? 0, title: e.settle ? 'Payment' : clean(e.title), amount: e.amount, summary } }
  },

  restore_expense: (w, a) => {
    const del = w.deleted ?? []
    let hits = str(a.expense_id) ? del.filter(d => d.id === str(a.expense_id)) : del.filter(d => !str(a.title) || norm(d.title).includes(norm(str(a.title))))
    if (str(a.group)) { const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }; hits = hits.filter(d => d.groupId === f.ok.id) }
    if (!hits.length) return { result: { error: 'Nothing deleted in the last 60 days matches that.' } }
    if (hits.length > 1) return { result: { error: 'More than one deleted expense matches. Ask which.', deleted: hits.slice(0, 8).map(d => ({ id: d.id, title: clean(d.title), amount: rs(d.amount), date: d.date, group: gname(w.groups.find(g => g.id === d.groupId)!) })) } }
    const d = hits[0], g = w.groups.find(x => x.id === d.groupId)!
    const summary = `Bring back “${clean(d.title)}” (${rs(d.amount)}, ${nice(d.date)}) in ${gname(g)}.`
    return { result: { drafted: summary, next: 'Shown as a card; restored only when the person taps Restore.' },
      card: { type: 'restore', groupId: g.id, group: gname(g), expenseId: d.id, title: clean(d.title), amount: d.amount, summary } }
  },
}
Object.assign(TOOLS, MORE)

export async function runTool(w: World, name: string, args: Args): Promise<ToolOut> {
  const t = TOOLS[name]
  if (!t) return { result: { error: `No tool called ${clean(name, 40)}.` } }
  try { return await t(w, args && typeof args === 'object' ? args : {}) } catch { return { result: { error: 'That didn’t work. Try asking another way.' } } }
}

const S = (description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', additionalProperties: false, description, properties, required })
const s = (description: string) => ({ type: 'string', description })
const n = (description: string) => ({ type: 'number', description })
const GROUP = s('Group name as the person said it (or a friend’s name for money outside groups). Omit for all groups.')
const CATS = { type: 'string', enum: ['food', 'groceries', 'stay', 'transport', 'drinks', 'fun', 'rent', 'bills', 'help', 'other'] }
/** OpenAI-style tool definitions for the model. */
export const TOOL_DEFS = [
  ['list_groups', 'The person’s groups with their balance in each.', S('No arguments.')],
  ['balances', 'Who owes whom. With a group: that group’s settle-up plan. Without: overall totals and balance with each person across groups.', S('', { group: GROUP })],
  ['find_expenses', 'Search the person’s expenses (settlements excluded).', S('', {
    text: s('Words in the title'), group: GROUP, person: s('Someone who paid or shares it'), category: CATS,
    from: s('YYYY-MM-DD'), to: s('YYYY-MM-DD'), min_amount: n('Rupees'), max_amount: n('Rupees'), limit: n('Up to 25'),
  })],
  ['spending', 'Totals of the person’s share (and the group total) grouped by category, month, group or payer.', S('', {
    by: { type: 'string', enum: ['category', 'month', 'group', 'person'] }, from: s('YYYY-MM-DD'), to: s('YYYY-MM-DD'), group: GROUP,
  })],
  ['activity', 'Recent changes in the person’s groups (who added, edited or deleted what), newest first.', S('', { group: GROUP, days: n('How far back, 1–90. Default 14.') })],
  ['draft_expense', 'Prepare a new expense for the person to confirm and adjust. It can be in a group, or with friends outside any group. Saves nothing. With an attached receipt, split it by item: describe groups of items in item_rules (e.g. {rule: "non-vegetarian food", people: ["Bala","Karan"]}); every item is sorted into a rule for you.', S('', {
    group: s('Group name. Omit when it is with friends outside a group.'),
    with: { type: 'array', items: { type: 'string' }, description: 'Friends’ names for an expense outside any group (not including the person).' },
    title: s('Short label'), amount: n('Total in rupees; omit when splitting a receipt by item'), paid_by: s('Who paid; omit for the person themselves'),
    split_between: { type: 'array', items: { type: 'string' }, description: 'Names to split between equally, including "me" if the person is in it. Omit for everyone.' },
    item_rules: { type: 'array', description: 'Receipt only: kinds of items and who shares each kind, from what the person said.', items: { type: 'object', additionalProperties: false, required: ['rule', 'people'], properties: { rule: s('A kind of item, e.g. "vegetarian food", "alcoholic drinks", "desserts"'), people: { type: 'array', items: { type: 'string' } } } } },
    item_assignments: { type: 'array', description: 'Receipt only: specific items by number and who had them, when the person named items directly.', items: { type: 'object', additionalProperties: false, required: ['item', 'people'], properties: { item: n('Item number from the receipt'), people: { type: 'array', items: { type: 'string' } } } } },
    leftover_people: { type: 'array', items: { type: 'string' }, description: 'Receipt only: who shares items no rule covers. Omit for everyone.' },
    category: CATS, date: s('YYYY-MM-DD; omit for today'),
  }, ['title'])],
  ['draft_settlement', 'Prepare settling up between the person and someone. Opens the settle-up screen when tapped.', S('', { person: s('Their name'), group: GROUP }, ['person'])],
  ['draft_reminder', 'Prepare a reminder to someone who owes the person money. Sent only when tapped.', S('', { person: s('Their name'), group: GROUP }, ['person'])],
  ['explain_balance', 'Why the person and someone owe what they do: the balance from the expenses themselves, group by group, the entries that moved it most, and the group’s settle-up plan when that differs.', S('', { person: s('Their name'), group: GROUP }, ['person'])],
  ['pending', 'Payments waiting for someone to confirm they arrived, and ones marked as not arrived, with ids.', S('No arguments.')],
  ['confirm_payment', 'Prepare confirming a payment someone says they made to the person (only payments to the person). A card with Got it / Not yet.', S('', { person: s('Who paid'), group: GROUP, amount: n('Rupees'), expense_id: s('Id from pending') })],
  ['mark_paid', 'Prepare recording a payment between the person and someone (money already paid, e.g. by UPI or cash). Defaults to what the group’s settle-up plan says. This is how to bring a balance to zero; there is no other way to change a balance.', S('', {
    person: s('Their name'), group: GROUP, amount: n('Rupees; omit for the full amount owed'),
    direction: { type: 'string', enum: ['they_paid_me', 'i_paid_them'], description: 'Omit to follow who owes whom' },
  }, ['person'])],
  ['edit_expense', 'Prepare changing an existing expense (not a payment): name, amount, date, category, who paid, or an equal split between named people. Changing the amount alone keeps everyone’s proportions. Get the id from find_expenses.', S('', {
    expense_id: s('From find_expenses'), title: s('New name'), amount: n('New total in rupees'), date: s('YYYY-MM-DD'), category: CATS, paid_by: s('Who paid it all'),
    split_between: { type: 'array', items: { type: 'string' }, description: 'Split equally between these names (include "me" if the person shares it)' },
  }, ['expense_id'])],
  ['delete_expense', 'Prepare deleting an expense or payment. It stays in history and can be restored. Get the id from find_expenses or pending.', S('', { expense_id: s('The id') }, ['expense_id'])],
  ['restore_expense', 'Prepare bringing back an expense deleted in the last 60 days.', S('', { title: s('Words in its name'), group: GROUP, expense_id: s('The id, if known') })],
].map(([name, description, parameters]) => ({ type: 'function', function: { name, description, parameters } }))
