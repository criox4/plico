// Offline-first sync. Every local edit is saved at once (store.ts); a debounced diff against the last
// synced snapshot turns edits into idempotent PUT/DELETE ops in a persisted outbox, flushed in order.
// When the outbox is empty we pull the server's truth. No coalescing: order is causal, ops are upserts.
import { useSyncExternalStore } from 'react'
import { ME, isVpa, runRecurring, uid, type Expense, type Group, type Theme, type Tone } from './logic'
import { blank, getState, onLocalChange, setRemote, update, type State } from './store'
import { API, authClient, token } from './auth-client'

type Op = { m: 'PUT' | 'DELETE' | 'POST'; path: string; body?: unknown }
type Status = { authed: boolean; pending: number; offline: boolean; error: string }

const OKEY = 'splittr-outbox'
let outbox: Op[] = (() => { try { return JSON.parse(localStorage.getItem(OKEY) || '[]') } catch { return [] } })()
let snap: State = getState()
let timer: ReturnType<typeof setTimeout> | undefined
let flushing = false
let missedPull = false // a pull was skipped because an edit was pending

let status: Status = { authed: !!(token.get() && getState().user), pending: outbox.length, offline: !navigator.onLine, error: '' }
const subs = new Set<() => void>()
const setStatus = (p: Partial<Status>) => { status = { ...status, ...p, pending: outbox.length }; subs.forEach(f => f()) }
export const useSync = () => useSyncExternalStore(f => (subs.add(f), () => subs.delete(f)), () => status)

const saveOutbox = () => localStorage.setItem(OKEY, JSON.stringify(outbox))

// ---------- local state -> server ops ----------
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sid = (g: Group, id: string) => (id === ME ? g.selfId! : id)
const mapKeys = (g: Group, o?: Record<string, number>) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [sid(g, k), v]))
const groupBody = (g: Group) => ({ name: g.name.trim() || 'Group', kind: g.kind, theme: g.theme, track: !!g.track, selfId: g.selfId })
const selfBody = (s: State) => ({ name: s.me.name.trim() || 'Me', upi: isVpa(s.me.upi) ? s.me.upi : null })
const memberBody = (m: Group['members'][number]) => ({ name: m.name.trim() || 'Someone', upi: m.upi && isVpa(m.upi) ? m.upi : null })
const expenseBody = (g: Group, e: Expense) => ({
  title: e.title, cat: e.cat, date: e.date, amount: e.amount, paid: mapKeys(g, e.paid), owed: mapKeys(g, e.owed),
  mode: e.mode ?? null, input: mapKeys(g, e.input) ?? null, settle: !!e.settle, repeat: e.repeat ?? null,
})
const profileBody = (s: State) => ({
  ...(s.me.name.trim() && { name: s.me.name.trim() }),
  ...(isVpa(s.me.upi) ? { upi: s.me.upi } : !s.me.upi && { upi: '' }),
  theme: s.theme, tone: s.tone,
})

export function diff(prev: State, next: State): Op[] {
  const profile: Op[] = [], groups: Op[] = [], members: Op[] = [], expenses: Op[] = []
  const delExp: Op[] = [], delMem: Op[] = [], delGroups: Op[] = []
  if (!same(profileBody(prev), profileBody(next))) profile.push({ m: 'POST', path: '/api/auth/update-user', body: profileBody(next) })
  const selfChanged = !same(selfBody(prev), selfBody(next))
  const old = new Map(prev.groups.map(g => [g.id, g]))
  for (const g of next.groups) {
    const o = old.get(g.id)
    const base = `/api/groups/${g.id}`
    if (!o || !same(groupBody(o), groupBody(g))) groups.push({ m: 'PUT', path: base, body: groupBody(g) })
    if (!o || selfChanged) members.push({ m: 'PUT', path: `${base}/members/${g.selfId}`, body: selfBody(next) })
    const om = new Map((o?.members ?? []).map(m => [m.id, m]))
    for (const m of g.members) {
      if (m.id === ME) continue
      const was = om.get(m.id)
      if (!was || !same(memberBody(was), memberBody(m))) members.push({ m: 'PUT', path: `${base}/members/${m.id}`, body: memberBody(m) })
    }
    for (const m of o?.members ?? []) if (m.id !== ME && !g.members.some(x => x.id === m.id)) delMem.push({ m: 'DELETE', path: `${base}/members/${m.id}` })
    const oe = new Map((o?.expenses ?? []).map(e => [e.id, e]))
    for (const e of g.expenses) {
      const was = oe.get(e.id)
      if (!was || !same(expenseBody(g, was), expenseBody(g, e))) expenses.push({ m: 'PUT', path: `${base}/expenses/${e.id}`, body: expenseBody(g, e) })
    }
    for (const e of o?.expenses ?? []) if (!g.expenses.some(x => x.id === e.id)) delExp.push({ m: 'DELETE', path: `${base}/expenses/${e.id}` })
  }
  for (const o of prev.groups) if (!next.groups.some(g => g.id === o.id)) delGroups.push({ m: 'DELETE', path: `/api/groups/${o.id}` })
  // Creation order is always valid: groups, then members, then expenses; deletes run in reverse.
  return [...profile, ...groups, ...members, ...expenses, ...delExp, ...delMem, ...delGroups]
}

function queueNow() {
  clearTimeout(timer)
  timer = undefined
  const cur = getState()
  if (!status.authed) { snap = cur; return }
  const ops = diff(snap, cur)
  snap = cur
  if (!ops.length) {
    if (missedPull) void pull()
    return
  }
  outbox.push(...ops)
  saveOutbox()
  setStatus({})
  void flush()
}

// ---------- network ----------
const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${token.get()}` })

async function flush() {
  if (flushing || !status.authed) return
  flushing = true
  try {
    while (outbox.length) {
      const op = outbox[0]
      let res: Response
      try {
        res = await fetch(API + op.path, { method: op.m, headers: headers(), body: op.body ? JSON.stringify(op.body) : undefined })
      } catch {
        return setStatus({ offline: true })
      }
      if (res.status === 401) return expired()
      if (res.status >= 500) return setStatus({ error: 'The server had trouble. Your changes are safe and will retry.' })
      // The server refused this change (validation, permissions). Drop it; the pull below restores the truth.
      if (!res.ok) console.warn('Server rejected change', op, await res.text())
      outbox.shift()
      saveOutbox()
      setStatus({ offline: false, error: '' })
    }
    await pull()
  } finally {
    flushing = false
    if (outbox.length && status.authed && !status.offline) setTimeout(() => void flush(), 0) // edits that landed mid-pull
  }
}

type ServerGroup = {
  id: string; name: string; kind: Group['kind']; theme: Group['theme']; track: boolean; createdById: string
  members: { id: string; name: string; upi: string | null; userId: string | null }[]
  expenses: {
    id: string; title: string; cat: string; date: string; amount: number; mode: Expense['mode'] | null; input: Record<string, number> | null
    settle: boolean; repeatNext: string | null; repeatDay: number | null; shares: { memberId: string; paid: number; owed: number }[]
  }[]
}

export function toClient(sg: ServerGroup, userId: string): Group {
  const self = sg.members.find(m => m.userId === userId)
  const id = (m: string) => (m === self?.id ? ME : m)
  return {
    id: sg.id, name: sg.name, kind: sg.kind, theme: sg.theme, track: sg.track || undefined, selfId: self?.id, mine: sg.createdById === userId,
    members: sg.members.map(m => (m.id === self?.id ? { id: ME, name: 'Me' } : { id: m.id, name: m.name, upi: m.upi ?? undefined })),
    expenses: sg.expenses.map(e => {
      const paid: Record<string, number> = {}, owed: Record<string, number> = {}
      for (const s of e.shares) {
        if (s.paid) paid[id(s.memberId)] = s.paid
        if (s.owed) owed[id(s.memberId)] = s.owed
      }
      return {
        id: e.id, title: e.title, cat: e.cat, date: e.date, amount: e.amount, paid, owed,
        mode: e.mode ?? undefined, input: e.input ? Object.fromEntries(Object.entries(e.input).map(([k, v]) => [id(k), v])) : undefined,
        settle: e.settle || undefined, repeat: e.repeatNext && e.repeatDay ? { next: e.repeatNext, day: e.repeatDay } : undefined,
      }
    }),
  }
}

export async function pull() {
  const user = getState().user
  if (outbox.length || !user || !status.authed) return
  let res: Response
  try { res = await fetch(`${API}/api/groups`, { headers: headers() }) } catch { return setStatus({ offline: true }) }
  if (res.status === 401) return expired()
  if (!res.ok) return
  const data = (await res.json()) as ServerGroup[]
  if (outbox.length || timer) { missedPull = true; return } // local edits pending: they win, and we pull again after
  missedPull = false
  setRemote(d => { d.groups = data.map(g => toClient(g, user.id)) })
  snap = getState()
  setStatus({ offline: false })
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, { ...init, headers: headers() })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || 'Something went wrong')
  return body as T
}

// ---------- auth lifecycle ----------
type AuthUser = { id: string; email: string; name: string; upi?: string | null; theme?: string | null; tone?: string | null }

/** After sign-in/up: adopt the account's profile, upload anything made on this device before, then sync. */
export async function signedIn(u: AuthUser) {
  const local = getState()
  const firstOnDevice = !local.user
  if (local.user && local.user.id !== u.id) { outbox = []; saveOutbox() } // different account: don't leak data across
  setRemote(d => {
    if (local.user && local.user.id !== u.id) Object.assign(d, structuredClone(blank))
    d.user = { id: u.id, email: u.email }
    d.me.name = u.name || d.me.name
    d.me.upi = u.upi || d.me.upi
    if (u.theme) d.theme = u.theme as Theme
    if (u.tone) d.tone = u.tone as Tone
    for (const g of d.groups) g.selfId ||= uid()
  })
  status = { ...status, authed: true }
  if (firstOnDevice && getState().groups.length) {
    outbox.push(...diff({ ...getState(), groups: [] }, getState()))
    saveOutbox()
  }
  snap = getState()
  setStatus({ authed: true, error: '' })
  await flush()
  await pull()
}

function expired() {
  token.clear()
  setStatus({ authed: false, error: 'Your session ended. Sign in again; unsynced changes are kept.' })
}

export async function signOut() {
  await authClient.signOut().catch(() => {})
  token.clear()
  outbox = []
  saveOutbox()
  setRemote(d => { Object.assign(d, structuredClone(blank)) })
  snap = getState()
  setStatus({ authed: false, error: '' })
}

/** Wire up once at boot. */
export function startSync() {
  onLocalChange(() => { clearTimeout(timer); timer = setTimeout(queueNow, 400) })
  addEventListener('online', () => { setStatus({ offline: false }); void flush() })
  addEventListener('offline', () => setStatus({ offline: true }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') queueNow() // never lose a debounced edit on app close
    else void flush().then(pull)
  })
  setInterval(() => { if (document.visibilityState === 'visible') void flush().then(pull) }, 30_000)
  if (!status.authed) return
  // Catch up monthly repeats (deterministic ids, so two devices never duplicate), then sync.
  update(s => s.groups.forEach(g => runRecurring(g)))
  authClient.getSession().then(r => {
    if (r.data === null && !r.error) expired() // server says no session; a network error just means offline
  }).catch(() => {})
  void flush().then(pull)
}
