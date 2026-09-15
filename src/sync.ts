// Offline-first sync. Every local edit is saved at once (store.ts); a debounced diff against the last
// synced snapshot turns edits into idempotent PUT/DELETE ops in a persisted outbox, flushed in order.
// When the outbox is empty we pull the server's truth. No coalescing: order is causal, ops are upserts.
import { useSyncExternalStore } from 'react'
import { ME, isVpa, runRecurring, uid, type Expense, type Group, type Theme, type Tone } from './logic'
import { blank, getState, onLocalChange, setRemote, update, type State } from './store'
import { API, authClient, token } from './auth-client'

type Op = { m: 'PUT' | 'DELETE' | 'POST'; path: string; body?: unknown }
type Status = {
  authed: boolean; booting: boolean; pending: number; offline: boolean; error: string
  google: boolean; googleWebClientId: string | null; googleIosClientId: string | null; ai: boolean
}

const OKEY = 'splittr-outbox'
let outbox: Op[] = (() => { try { return JSON.parse(localStorage.getItem(OKEY) || '[]') } catch { return [] } })()
let snap: State = getState()
let timer: ReturnType<typeof setTimeout> | undefined
let flushing = false
let missedPull = false // a pull was skipped because an edit was pending

// Signed in = we know the user. A dead session is only concluded from the server (never from being offline).
let status: Status = {
  authed: !!getState().user, booting: true, pending: outbox.length, offline: !navigator.onLine, error: '',
  google: false, googleWebClientId: null, googleIosClientId: null, ai: false,
}
const subs = new Set<() => void>()
const setStatus = (p: Partial<Status>) => { status = { ...status, ...p, pending: outbox.length }; subs.forEach(f => f()) }
export const useSync = () => useSyncExternalStore(f => (subs.add(f), () => subs.delete(f)), () => status)

const saveOutbox = () => localStorage.setItem(OKEY, JSON.stringify(outbox))

// ---------- local state -> server ops ----------
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const sid = (g: Group, id: string) => (id === ME ? g.selfId! : id)
const mapKeys = (g: Group, o?: Record<string, number>) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [sid(g, k), v]))
const groupBody = (g: Group) => ({ name: g.name.trim() || 'Group', kind: g.kind, theme: g.theme, track: !!g.track, emoji: g.emoji || null, cover: g.cover || null, selfId: g.selfId })
const selfBody = (s: State) => ({ name: s.me.name.trim() || 'Me', upi: isVpa(s.me.upi) ? s.me.upi : null })
const memberBody = (m: Group['members'][number]) => ({
  name: m.name.trim() || 'Someone', upi: m.upi && isVpa(m.upi) ? m.upi : null,
  email: m.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email) ? m.email.trim().toLowerCase() : null,
  phone: m.phone && /^\+?[0-9 ()-]{7,20}$/.test(m.phone) ? m.phone.trim() : null,
})
const expenseBody = (g: Group, e: Expense) => ({
  title: e.title, cat: e.cat, date: e.date, amount: e.amount, paid: mapKeys(g, e.paid), owed: mapKeys(g, e.owed),
  mode: e.mode ?? null, input: mapKeys(g, e.input) ?? null, settle: !!e.settle, pending: !!e.pending, rejected: !!e.rejected, receipt: e.receipt ?? null, repeat: e.repeat ?? null,
})
export const isPhone = (p = '') => /^\+?[0-9 ()-]{7,20}$/.test(p.trim())
const profileBody = (s: State) => ({
  ...(s.me.name.trim() && { name: s.me.name.trim() }),
  ...(isPhone(s.me.phone) ? { phone: s.me.phone!.trim() } : !s.me.phone && { phone: '' }),
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
// Web: same-origin session cookie; native: bearer token. Send whichever exists.
const headers = (): Record<string, string> => ({ 'Content-Type': 'application/json', ...(token.get() && { Authorization: `Bearer ${token.get()}` }) })
const req = (path: string, init: RequestInit = {}) => fetch(API + path, { ...init, headers: headers(), credentials: 'include' })

async function flush() {
  if (flushing || !status.authed) return
  flushing = true
  try {
    while (outbox.length) {
      const op = outbox[0]
      let res: Response
      try {
        res = await req(op.path, { method: op.m, body: op.body ? JSON.stringify(op.body) : undefined })
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
  id: string; name: string; kind: Group['kind']; theme: Group['theme']; track: boolean; emoji: string | null; cover: string | null; createdById: string
  members: { id: string; name: string; upi: string | null; userId: string | null; email: string | null; phone: string | null; invitedAt: string | null; user?: { image: string | null } | null }[]
  expenses: {
    id: string; title: string; cat: string; date: string; amount: number; mode: Expense['mode'] | null; input: Record<string, number> | null
    settle: boolean; pending: boolean; rejected: boolean; receipt: string | null; repeatNext: string | null; repeatDay: number | null; shares: { memberId: string; paid: number; owed: number }[]
  }[]
}

export function toClient(sg: ServerGroup, userId: string): Group {
  const self = sg.members.find(m => m.userId === userId)
  const id = (m: string) => (m === self?.id ? ME : m)
  return {
    id: sg.id, name: sg.name, kind: sg.kind, theme: sg.theme, track: sg.track || undefined, emoji: sg.emoji ?? undefined, cover: sg.cover ?? undefined, selfId: self?.id, mine: sg.createdById === userId,
    members: sg.members.map(m => (m.id === self?.id ? { id: ME, name: 'Me' } : {
      id: m.id, name: m.name, upi: m.upi ?? undefined, email: m.email ?? undefined, phone: m.phone ?? undefined,
      joined: !!m.userId || undefined, invited: !!m.invitedAt || undefined, image: m.user?.image ?? undefined,
    })),
    expenses: sg.expenses.map(e => {
      const paid: Record<string, number> = {}, owed: Record<string, number> = {}
      for (const s of e.shares) {
        if (s.paid) paid[id(s.memberId)] = s.paid
        if (s.owed) owed[id(s.memberId)] = s.owed
      }
      return {
        id: e.id, title: e.title, cat: e.cat, date: e.date, amount: e.amount, paid, owed,
        mode: e.mode ?? undefined, input: e.input ? Object.fromEntries(Object.entries(e.input).map(([k, v]) => [id(k), v])) : undefined,
        settle: e.settle || undefined, pending: e.pending || undefined, rejected: e.rejected || undefined, receipt: e.receipt ?? undefined, repeat: e.repeatNext && e.repeatDay ? { next: e.repeatNext, day: e.repeatDay } : undefined,
      }
    }),
  }
}

export async function pull() {
  const user = getState().user
  if (outbox.length || !user || !status.authed) return
  let res: Response
  try { res = await req('/api/groups') } catch { return setStatus({ offline: true }) }
  if (res.status === 401) return expired()
  if (!res.ok) return
  const data = (await res.json()) as ServerGroup[]
  if (outbox.length || timer) { missedPull = true; return } // local edits pending: they win, and we pull again after
  missedPull = false
  setRemote(d => { d.groups = data.map(g => toClient(g, user.id)) })
  snap = getState()
  setStatus({ offline: false })
}

/** Shrink a photo on the phone before it travels: JPEG, longest side at most `max`. */
export async function shrink(f: Blob, max: number): Promise<Blob> {
  const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => { throw new Error('Couldn’t read that photo. Try a JPEG or PNG.') })
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k)
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  return new Promise((ok, no) => c.toBlob(b => (b ? ok(b) : no(new Error('Couldn’t read that photo.'))), 'image/jpeg', 0.82))
}

/** Upload a photo (needs a connection). Syncs first so the group it belongs to exists on the server. */
export async function uploadImage<T>(path: string, f: Blob, max: number): Promise<T> {
  const body = await shrink(f, max)
  await flush()
  const res = await fetch(API + path, { method: 'POST', body, credentials: 'include',
    headers: { 'Content-Type': body.type, ...(token.get() && { Authorization: `Bearer ${token.get()}` }) } })
    .catch(() => { throw new Error('Photos need a connection. Try again when you’re online.') })
  const out = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(out.error || 'Upload didn’t work. Try again.')
  return out as T
}

export type Read = { title: string; amount: number | null; cat: string; date: string | null; payer: string | null; people: string[]; items: { name: string; amount: number }[]; extras: number }
const dataUrl = (b: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(b) })
/** Ask the server to read an expense out of a sentence or a photo (receipt, order, UPI screenshot). */
export async function readExpense(src: { text?: string; image?: Blob; groupId?: string }) {
  const image = src.image && await dataUrl(await shrink(src.image, 1600))
  return api<Read>('/api/ai/read', { method: 'POST', body: JSON.stringify({ text: src.text, image, groupId: src.groupId, today: new Date().toLocaleDateString('en-CA') }) })
    .catch(e => { throw new Error(navigator.onLine ? (e as Error).message : 'Reading photos needs a connection. You can still type it in.') })
}

/** A private group file as a local URL (bearer-authenticated, so it works in the native apps too). */
export async function fileUrl(path: string) {
  const res = await req(path)
  if (!res.ok) throw new Error('Couldn’t load the photo')
  return URL.createObjectURL(await res.blob())
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await req(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || 'Something went wrong')
  return body as T
}

// ---------- auth lifecycle ----------
type AuthUser = { id: string; email: string; name: string; phone?: string | null; emailVerified?: boolean; image?: string | null; upi?: string | null; theme?: string | null; tone?: string | null }

/** After sign-in/up: adopt the account's profile, upload anything made on this device before, then sync. */
export async function signedIn(u: AuthUser) {
  const local = getState()
  const firstOnDevice = !local.user
  if (local.user && local.user.id !== u.id) { outbox = []; saveOutbox() } // different account: don't leak data across
  setRemote(d => {
    if (local.user && local.user.id !== u.id) Object.assign(d, structuredClone(blank))
    d.user = { id: u.id, email: u.email, emailVerified: !!u.emailVerified, image: u.image }
    d.me.name = u.name || d.me.name
    d.me.upi = u.upi || d.me.upi
    d.me.phone = u.phone || d.me.phone
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
  // Keep state.user so signing back in as the same person keeps the outbox, and a different person gets a clean slate.
  setStatus({ authed: false, error: 'Your session ended. Sign in again; unsynced changes are kept.' })
}

/** Refresh account fields (verification, name) from the server session. */
export async function refreshUser() {
  const r = await authClient.getSession().catch(() => null)
  const u = r?.data?.user
  if (u) setRemote(d => { if (d.user) Object.assign(d.user, { email: u.email, emailVerified: u.emailVerified, image: u.image }); d.me.name = u.name || d.me.name })
  return u
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
  // Boot: learn the sign-in options and confirm the session, but never hold an offline user hostage (800ms cap).
  const config = fetch(`${API}/api/config`).then(r => r.json())
    .then(c => setStatus({ google: !!c.google, googleWebClientId: c.googleWebClientId, googleIosClientId: c.googleIosClientId, ai: !!c.ai })).catch(() => {})
  const session = authClient.getSession().then(async r => {
    const u = r.data?.user
    if (u && !getState().user) return signedIn(u) // back from Google's redirect with a session cookie
    if (u) setRemote(d => { if (d.user) Object.assign(d.user, { emailVerified: u.emailVerified, image: u.image }) })
    if (r.data === null && !r.error && getState().user) expired() // the server says no session; a network error only means offline
  }).catch(() => {})
  void Promise.race([Promise.all([config, session]), new Promise(r => setTimeout(r, 800))]).then(() => setStatus({ booting: false }))
  if (!status.authed) return
  // Catch up monthly repeats (deterministic ids, so two devices never duplicate), then sync.
  update(s => s.groups.forEach(g => runRecurring(g)))
  void flush().then(pull)
}
