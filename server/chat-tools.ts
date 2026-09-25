// Ask Plico's tools. Every tool works on a World: the signed-in person's own groups, loaded by chat.ts before the
// model runs. The model can name groups and people, but only inside this world: nothing else is reachable from here.
// Money is computed and written out here, so the model never does arithmetic. Drafts only describe an action; the
// app performs it when the person taps.
import { allocate, balances, inr, pairwise, simplify, type Expense, type Group } from '../src/logic.ts'

export type WMember = { id: string; name: string; email: string | null; joined: boolean }
export type WGroup = Group & { meId: string; people: WMember[]; kind: string }
export type WEvent = { groupId: string; kind: string; byName: string; at: string; title: string | null; amount: number | null; effect: Record<string, number> }
export type World = { me: { name: string; email: string }; today: string; groups: WGroup[]; events: WEvent[] }

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

export type Card =
  | { type: 'expense'; groupId: string; group: string; title: string; cat: string; date: string; amount: number; paid: Record<string, number>; owed: Record<string, number>; summary: string }
  | { type: 'settle'; groupId: string; group: string; from: string; to: string; amount: number; summary: string }
  | { type: 'remind'; groupId: string; group: string; memberId: string; name: string; amount: number; summary: string }
export type ToolOut = { result: unknown; card?: Card }

const TOOLS: Record<string, (w: World, a: Args) => ToolOut> = {
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
    const text = norm(str(a.text)), cat = str(a.category), from = day(a.from), to = day(a.to), min = num(a.min_amount), max = num(a.max_amount)
    let gs = w.groups
    if (str(a.group)) { const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }; gs = [f.ok] }
    const rows = gs.flatMap(g => {
      let person: string | null = null
      if (str(a.person)) { const p = findPerson(g, str(a.person)); if ('error' in p) return []; person = p.ok.id }
      return g.expenses.filter(e => !e.settle
        && (!text || norm(e.title).includes(text)) && (!cat || e.cat === cat) && (!from || e.date >= from) && (!to || e.date <= to)
        && (min === undefined || e.amount >= min * 100) && (max === undefined || e.amount <= max * 100)
        && (!person || e.paid[person] || e.owed[person])).map(e => ({ g, e }))
    }).sort((x, y) => y.e.date.localeCompare(x.e.date))
    const limit = Math.min(Math.max(num(a.limit) ?? 15, 1), 25)
    return { result: {
      count: rows.length, total: rs(rows.reduce((s, r) => s + r.e.amount, 0)), your_share_total: rs(rows.reduce((s, r) => s + (r.e.owed[r.g.meId] ?? 0), 0)),
      expenses: rows.slice(0, limit).map(({ g, e }) => ({
        date: e.date, title: clean(e.title), group: gname(g), category: e.cat, amount: rs(e.amount),
        paid_by: Object.keys(e.paid).map(id => who(g, id)).join(', '), your_share: rs(e.owed[g.meId] ?? 0),
      })),
      ...(rows.length > limit && { note: `Showing the latest ${limit} of ${rows.length}.` }),
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
      return { when: e.at.slice(0, 16).replace('T', ' '), group: gname(g), by: clean(e.byName, 40), what: e.kind.replace('.', ' '), title: e.title ? clean(e.title) : null, amount: e.amount ? rs(e.amount) : null, your_balance_change: mine ? signed(mine) : null }
    }) } }
  },

  draft_expense: (w, a) => {
    const f = findGroup(w, str(a.group)); if ('error' in f) return { result: f }
    const g = f.ok
    const amount = Math.round((num(a.amount) ?? 0) * 100)
    if (amount < 100 || amount > 1e9) return { result: { error: 'Need an amount between ₹1 and ₹1,00,00,000.' } }
    const payer = str(a.paid_by) ? findPerson(g, str(a.paid_by)) : { ok: g.people.find(p => p.id === g.meId)! }
    if ('error' in payer) return { result: payer }
    const names = Array.isArray(a.split_between) ? a.split_between.map(String).slice(0, 50) : []
    const among: string[] = []
    for (const n of names) { const p = findPerson(g, n); if ('error' in p) return { result: p }; among.push(p.ok.id) }
    const ids = [...new Set(among.length ? among : g.people.map(p => p.id))]
    const owed = allocate(amount, Object.fromEntries(ids.map(id => [id, 1])))
    const title = clean(a.title, 60) || 'Expense'
    const cat = ['food', 'groceries', 'stay', 'transport', 'drinks', 'fun', 'rent', 'bills', 'help', 'other'].includes(str(a.category)) ? str(a.category) : 'other'
    const date = day(a.date) ?? w.today
    const summary = `${title}: ${rs(amount)} in ${gname(g)}, paid by ${who(g, payer.ok.id)}, split equally between ${ids.map(id => who(g, id)).join(', ')} (${rs(Math.min(...Object.values(owed)))}${new Set(Object.values(owed)).size > 1 ? '–' + rs(Math.max(...Object.values(owed))) : ''} each).`
    return { result: { drafted: summary, next: 'Shown to the person as a card with an Add button. Nothing is saved until they tap it.' },
      card: { type: 'expense', groupId: g.id, group: gname(g), title, cat, date, amount, paid: { [payer.ok.id]: amount }, owed, summary } }
  },

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

export function runTool(w: World, name: string, args: Args): ToolOut {
  const t = TOOLS[name]
  if (!t) return { result: { error: `No tool called ${clean(name, 40)}.` } }
  try { return t(w, args && typeof args === 'object' ? args : {}) } catch { return { result: { error: 'That didn’t work. Try asking another way.' } } }
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
  ['draft_expense', 'Prepare a new expense for the person to confirm. Equal split. Does not save anything.', S('', {
    group: s('Group name'), title: s('Short label'), amount: n('Total in rupees'), paid_by: s('Who paid; omit for the person themselves'),
    split_between: { type: 'array', items: { type: 'string' }, description: 'Names to split between, including "me" if the person is in it. Omit for everyone in the group.' },
    category: CATS, date: s('YYYY-MM-DD; omit for today'),
  }, ['group', 'title', 'amount'])],
  ['draft_settlement', 'Prepare settling up between the person and someone. Opens the settle-up screen when tapped.', S('', { person: s('Their name'), group: GROUP }, ['person'])],
  ['draft_reminder', 'Prepare a reminder to someone who owes the person money. Sent only when tapped.', S('', { person: s('Their name'), group: GROUP }, ['person'])],
].map(([name, description, parameters]) => ({ type: 'function', function: { name, description, parameters } }))
