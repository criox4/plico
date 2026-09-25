// Offline-first sync. Every local edit is saved at once (store.ts); a debounced diff against the last
// synced snapshot turns edits into idempotent PUT/DELETE ops in a persisted outbox, flushed in order.
// Expense ops carry the version they started from, so the server can refuse a stale edit (409): that becomes
// an "issue" the person resolves (keep mine / keep theirs), never a silent overwrite. Refused changes become
// issues too. When the outbox is empty we pull what changed since the last pull (a full pull at boot).
import { useSyncExternalStore } from 'react'
import { Capacitor } from '@capacitor/core'
import { Preferences } from '@capacitor/preferences'
import { ME, enqueue, isVpa, rebase, runRecurring, uid, type Expense, type Group, type Op, type Theme, type Tone } from './logic'
import { ConflictOut, GroupsOut, ReadOut, SavedOut, UnreadOut, type ExpenseInput, type Read, type ServerExpense, type ServerGroup, type Snap, type SnapFull } from './schema'
export type { Read, ServerExpense }
import { blank, getState, onLocalChange, setRemote, update, type State } from './store'
import { API, authClient, token } from './auth-client'

/** A change the server wouldn't take as-is. Conflict: someone changed it first. Failed: refused outright. */
export type Issue = {
  id: string; kind: 'conflict' | 'failed'; gid: string; eid?: string; title: string; op: Op; at: string
  message?: string // failed: why
  theirs?: ServerExpense | null // conflict: the version on the server now
  by?: string; action?: string // conflict: who changed it, and how (edited, deleted, ...)
}
type Status = {
  authed: boolean; booting: boolean; pending: number; offline: boolean; error: string; issues: Issue[]
  unread: number // Activity entries by other people you haven't seen
  google: boolean; googleWebClientId: string | null; googleIosClientId: string | null; ai: boolean
  push: { web: string | null; ios: boolean; android: boolean } // push channels the server can send on; web is the VAPID public key
}

// Unsynced work must survive the OS clearing WebView storage: on phones it's mirrored to native preferences
// (SharedPreferences / UserDefaults), which aren't evicted, and restored at boot if the WebView copy is gone.
const OKEY = 'splittr-outbox', IKEY = 'plico-issues', WKEY = 'plico-outbox-owner', CKEY = 'plico-cursor'
const native = Capacitor.isNativePlatform()
const read = <T>(k: string, empty: T): T => { try { return JSON.parse(localStorage.getItem(k) ?? '') ?? empty } catch { return empty } }
const keep = (k: string, v: unknown) => {
  const s = JSON.stringify(v)
  try { localStorage.setItem(k, s) } catch { /* full or blocked: the native copy still holds it */ }
  if (native) void Preferences.set({ key: k, value: s }).catch(() => {})
}
async function restoreDurable() {
  if (!native) return
  let restored = false
  for (const k of [OKEY, IKEY, WKEY]) {
    if (localStorage.getItem(k) !== null) continue
    const { value } = await Preferences.get({ key: k }).catch(() => ({ value: null }))
    if (value) { localStorage.setItem(k, value); restored = true }
  }
  if (restored) { outbox = [...read<Op[]>(OKEY, []), ...outbox]; issues = read(IKEY, []) }
}

let outbox: Op[] = read(OKEY, [])
let issues: Issue[] = read(IKEY, [])
let cursor: string | null = localStorage.getItem(CKEY) // last pull's server time; null = next pull is a full one
let snap: State = getState()
let timer: ReturnType<typeof setTimeout> | undefined
let flushing = false
let sending = false // outbox[0] is on the wire: don't fold newer edits into it
let missedPull = false // a pull was skipped because an edit was pending

// Signed in = we know the user. A dead session is only concluded from the server (never from being offline).
let status: Status = {
  authed: !!getState().user, booting: true, pending: outbox.length, offline: !navigator.onLine, error: '', issues, unread: 0,
  google: false, googleWebClientId: null, googleIosClientId: null, ai: false, push: { web: null, ios: false, android: false },
}
const subs = new Set<() => void>()
const setStatus = (p: Partial<Status>) => { status = { ...status, ...p, pending: outbox.length, issues }; subs.forEach(f => f()) }
export const useSync = () => useSyncExternalStore(f => (subs.add(f), () => subs.delete(f)), () => status)

const saveOutbox = () => { keep(OKEY, outbox); if (getState().user) keep(WKEY, getState().user!.id) }
const saveIssues = () => keep(IKEY, issues)
const setCursor = (c: string | null) => { cursor = c; c ? localStorage.setItem(CKEY, c) : localStorage.removeItem(CKEY) }

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
const expenseBody = (g: Group, e: Expense): ExpenseInput => ({
  title: e.title, cat: e.cat, date: e.date, amount: e.amount, paid: mapKeys(g, e.paid)!, owed: mapKeys(g, e.owed)!,
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
      // base: the version this edit started from (a copy put back after a conflict carries its own).
      if (!was || !same(expenseBody(g, was), expenseBody(g, e))) expenses.push({ m: 'PUT', path: `${base}/expenses/${e.id}`, body: expenseBody(g, e), base: was?.v ?? e.v ?? null })
    }
    for (const e of o?.expenses ?? []) if (!g.expenses.some(x => x.id === e.id)) delExp.push({ m: 'DELETE', path: `${base}/expenses/${e.id}`, base: e.v ?? null })
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
  for (const op of ops) outbox = enqueue(outbox, op, sending)
  saveOutbox()
  setStatus({})
  void flush()
}

// ---------- network ----------
// Web: same-origin session cookie; native: bearer token. Send whichever exists.
const headers = (): Record<string, string> => ({ 'Content-Type': 'application/json', ...(token.get() && { Authorization: `Bearer ${token.get()}` }) })
const req = (path: string, init: RequestInit = {}) => fetch(API + path, { ...init, headers: headers(), credentials: 'include' })
/** A signed-in request whose response you read yourself (e.g. a stream). */
export const request = req

/** Push queued changes now (e.g. right after a parent's consent unlocks the account). */
export const syncNow = () => flush()

const opIds = (path: string) => path.match(/^\/api\/groups\/([^/?]+)(?:\/expenses\/([^/?]+))?/) ?? []
const groupName = (gid: string) => snap.groups.find(g => g.id === gid)?.name ?? getState().groups.find(g => g.id === gid)?.name

/** Record the server's version for an expense locally (state and snapshot alike, so nothing gets queued). */
function setVersion(gid: string, eid: string, v: number) {
  const bump = (st: State) => { const e = st.groups.find(g => g.id === gid)?.expenses.find(x => x.id === eid); if (e) e.v = v }
  setRemote(bump)
  snap = structuredClone(snap); bump(snap)
}

function addIssue(i: Omit<Issue, 'id' | 'at'>) {
  issues = [...issues, { ...i, id: uid(), at: new Date().toISOString() }]
  saveIssues()
  setCursor(null) // what's on this phone no longer matches the server: the next pull fetches everything
}

async function flush() {
  if (flushing || !status.authed) return
  flushing = true
  try {
    while (outbox.length) {
      const op = outbox[0]
      const url = op.m === 'DELETE' && op.base != null ? `${op.path}?base=${op.base}` : op.path
      const body = op.body ? JSON.stringify('base' in op && op.m === 'PUT' ? { ...(op.body as object), base: op.base } : op.body) : undefined
      let res: Response
      sending = true
      try {
        res = await req(url, { method: op.m, body })
      } catch {
        return setStatus({ offline: true })
      } finally { sending = false }
      if (res.status === 401) return expired()
      if (res.status >= 500) return setStatus({ error: 'The server had trouble. Your changes are safe and will retry.' })
      const raw: unknown = await res.json().catch(() => ({}))
      const { code, error } = raw as { code?: string; error?: string }
      // Waiting on the age question or a parent's consent: keep everything and try again once it's sorted.
      if (res.status === 403 && (code === 'age' || code === 'guardian')) return
      outbox.shift()
      const [, gid, eid] = opIds(op.path)
      const title = (op.body as { title?: string })?.title ?? snap.groups.find(g => g.id === gid)?.expenses.find(e => e.id === eid)?.title ?? groupName(gid) ?? 'A change'
      const clash = res.status === 409 ? ConflictOut.safeParse(raw) : null
      if (clash?.success) {
        // Someone changed it first: keep both versions and ask. Their version shows here after the pull.
        addIssue({ kind: 'conflict', gid, eid, title, op, theirs: clash.data.theirs, by: clash.data.by, action: clash.data.action })
      } else if (res.status === 404 && gid) {
        // The group is gone (deleted, or we were removed): everything else queued for it would fail the same way.
        outbox = outbox.filter(o => opIds(o.path)[1] !== gid)
        addIssue({ kind: 'failed', gid, title: groupName(gid) ?? 'A group', op, message: 'This group was deleted, or you were removed from it, so changes you made there couldn’t be saved.' })
      } else if (!res.ok) {
        addIssue({ kind: 'failed', gid, eid, title, op, message: error || 'The server didn’t accept this change.' })
      } else {
        const saved = SavedOut.safeParse(raw)
        if (eid && saved.success && saved.data.version !== undefined) {
          outbox = rebase(outbox, op.path, saved.data.version)
          if (op.m === 'PUT') setVersion(gid, eid, saved.data.version)
        }
      }
      saveOutbox()
      setStatus({ offline: false, error: '' })
    }
    await pull()
  } finally {
    flushing = false
    if (outbox.length && status.authed && !status.offline) setTimeout(() => void flush(), 0) // edits that landed mid-pull
  }
}

/** A server expense (or a history snapshot) in the phone's shape: my member id becomes ME. */
export function expenseFromServer(e: Omit<ServerExpense, 'version' | 'deletedAt' | 'updatedAt' | 'mode' | 'input' | 'repeatDay'> & Partial<ServerExpense>, selfId?: string): Expense {
  const id = (m: string) => (m === selfId ? ME : m)
  const paid: Record<string, number> = {}, owed: Record<string, number> = {}
  for (const s of e.shares) {
    if (s.paid) paid[id(s.memberId)] = s.paid
    if (s.owed) owed[id(s.memberId)] = s.owed
  }
  return {
    id: e.id, title: e.title, cat: e.cat, date: e.date, amount: e.amount, paid, owed,
    mode: e.mode ?? undefined, input: e.input ? Object.fromEntries(Object.entries(e.input).map(([k, v]) => [id(k), v])) : undefined,
    settle: e.settle || undefined, pending: e.pending || undefined, rejected: e.rejected || undefined, receipt: e.receipt ?? undefined,
    repeat: e.repeatNext && e.repeatDay ? { next: e.repeatNext, day: e.repeatDay } : undefined, v: e.version,
  }
}

/** A queued edit's body (server member ids) as a history-style snapshot, to compare with theirs. */
export function bodySnap(b: ExpenseInput): Snap {
  const ids = [...new Set([...Object.keys(b.paid ?? {}), ...Object.keys(b.owed ?? {})])].sort()
  return { title: b.title, cat: b.cat, date: b.date, amount: b.amount, settle: b.settle, pending: b.pending, rejected: b.rejected, receipt: b.receipt, repeatNext: b.repeat?.next ?? null,
    shares: ids.map(memberId => ({ memberId, paid: b.paid?.[memberId] ?? 0, owed: b.owed?.[memberId] ?? 0 })) }
}

export function toClient(sg: ServerGroup, userId: string): Group {
  const self = sg.members.find(m => m.userId === userId)
  return {
    id: sg.id, name: sg.name, kind: sg.kind, theme: sg.theme, track: sg.track || undefined, emoji: sg.emoji ?? undefined, cover: sg.cover ?? undefined, selfId: self?.id, mine: sg.createdById === userId,
    members: sg.members.map(m => (m.id === self?.id ? { id: ME, name: 'Me' } : {
      id: m.id, name: m.name, upi: m.upi ?? undefined, email: (m.email ?? m.user?.email)?.toLowerCase() || undefined, phone: m.phone ?? undefined,
      joined: !!m.userId || undefined, invited: !!m.invitedAt || undefined, image: m.user?.image ?? undefined,
    })),
    expenses: sg.expenses.filter(e => !e.deletedAt).map(e => expenseFromServer(e, self?.id)),
  }
}

export async function pull() {
  const user = getState().user
  if (outbox.length || !user || !status.authed) return
  const known = getState().groups.map(g => g.id)
  const q = cursor ? `?since=${encodeURIComponent(cursor)}&known=${known.join(',')}` : ''
  let res: Response
  try { res = await req('/api/groups' + q) } catch { return setStatus({ offline: true }) }
  if (res.status === 401) return expired()
  if (!res.ok) return
  // Checked before it touches the phone's copy: a malformed answer must never overwrite good data.
  const parsed = GroupsOut.safeParse(await res.json().catch(() => null))
  if (!parsed.success) {
    console.warn('Unexpected sync answer', parsed.error.issues.slice(0, 3))
    return setStatus({ error: 'Plico got an answer from the server it doesn’t understand. Your data is safe. Update the app or try again later.' })
  }
  const data = parsed.data
  if (outbox.length || timer) { missedPull = true; return } // local edits pending: they win, and we pull again after
  missedPull = false
  let gap = false
  setRemote(d => {
    const old = new Map(d.groups.map(g => [g.id, g]))
    // Groups not in the answer are gone for us (deleted, or we were removed).
    d.groups = data.groups.map(sg => {
      const fresh = toClient(sg, user.id)
      if (sg.full) return fresh
      const was = old.get(sg.id)
      if (!was) { gap = true; return fresh } // shouldn't happen (we said we knew it): fetch everything next time
      const byId = new Map(was.expenses.map(e => [e.id, e]))
      for (const e of sg.expenses) e.deletedAt ? byId.delete(e.id) : byId.set(e.id, expenseFromServer(e, fresh.selfId))
      return { ...fresh, expenses: [...byId.values()] }
    })
  })
  setCursor(gap ? null : data.now)
  snap = getState()
  setStatus({ offline: false })
  void req('/api/me/activity?peek=1').then(r => (r.ok ? r.json() : null)).then(j => { const u = UnreadOut.safeParse(j); if (u.success) setStatus({ unread: u.data.unread }) }).catch(() => {})
}

/** The Activity tab was looked at up to this entry: clears the badge here and on other devices. */
export async function seenActivity(at: string) {
  setStatus({ unread: 0 })
  await req('/api/me/activity/seen', { method: 'POST', body: JSON.stringify({ at }) }).catch(() => {})
}

// ---------- issues: conflicts and refused changes ----------
/** Put one expense in place locally, as-if from the server (state and snapshot alike, so it isn't queued again). */
function placeLocal(gid: string, eid: string, e: Expense | null) {
  const put = (st: State) => {
    const g = st.groups.find(x => x.id === gid)
    if (!g) return
    const i = g.expenses.findIndex(x => x.id === eid)
    if (!e) { if (i >= 0) g.expenses.splice(i, 1) } else if (i >= 0) g.expenses[i] = e; else g.expenses.push(e)
  }
  setRemote(put)
  snap = structuredClone(snap); put(snap)
}

/**
 * mine: send my version again, on top of theirs (base = their version). theirs: drop mine.
 * retry: send a refused change again. discard: drop it. Either way the next pull shows the server's truth.
 */
export function resolveIssue(id: string, choice: 'mine' | 'theirs' | 'retry' | 'discard') {
  const it = issues.find(i => i.id === id)
  if (!it) return
  issues = issues.filter(i => i !== it)
  saveIssues()
  if (choice === 'mine' || choice === 'retry') {
    const op: Op = it.kind === 'conflict' ? { ...it.op, base: it.theirs?.version ?? null } : it.op
    if (it.eid) {
      const g = getState().groups.find(x => x.id === it.gid)
      const b = op.body as ExpenseInput | undefined
      placeLocal(it.gid, it.eid, op.m === 'DELETE' || !b ? null
        : expenseFromServer({ id: it.eid, ...bodySnap(b), mode: b.mode, input: b.input, repeatDay: b.repeat?.day ?? null, version: op.base ?? undefined }, g?.selfId))
    }
    outbox = enqueue(outbox, op, sending)
    saveOutbox()
    setStatus({})
    void flush()
  } else {
    setStatus({})
    void pull()
  }
}

/** Online-only history actions: restore a deleted expense, or put back an older version. Then pull. */
export async function restoreExpense(gid: string, eid: string) {
  await api(`/api/groups/${gid}/expenses/${eid}/restore`, { method: 'POST' })
  await flush(); await pull()
}
export async function revertExpense(gid: string, eid: string, to: SnapFull, version: number, current: number) {
  const paid: Record<string, number> = {}, owed: Record<string, number> = {}
  for (const x of to.shares) { if (x.paid) paid[x.memberId] = x.paid; if (x.owed) owed[x.memberId] = x.owed }
  await api(`/api/groups/${gid}/expenses/${eid}`, { method: 'PUT', body: JSON.stringify({
    title: to.title, cat: to.cat, date: to.date, amount: to.amount, paid, owed, mode: to.mode ?? null, input: to.input ?? null,
    settle: !!to.settle, pending: !!to.pending, rejected: !!to.rejected, receipt: to.receipt ?? null,
    repeat: to.repeatNext && to.repeatDay ? { next: to.repeatNext, day: to.repeatDay } : null, base: current, revertOf: version,
  }) })
  await flush(); await pull()
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

const dataUrl = (b: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => no(r.error); r.readAsDataURL(b) })
/** Ask the server to read an expense out of a sentence or a photo (receipt, order, UPI screenshot). */
export async function readExpense(src: { text?: string; image?: Blob; groupId?: string }) {
  const image = src.image && await dataUrl(await shrink(src.image, 1600))
  return api<unknown>('/api/ai/read', { method: 'POST', body: JSON.stringify({ text: src.text, image, groupId: src.groupId, today: new Date().toLocaleDateString('en-CA') }) })
    .then((r): Read => ReadOut.parse(r))
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
type AuthUser = { id: string; email: string; name: string; phone?: string | null; emailVerified?: boolean; image?: string | null; upi?: string | null; theme?: string | null; tone?: string | null
  ageGroup?: string | null; guardianEmail?: string | null; guardianConsentAt?: string | Date | null; aiOffAt?: string | Date | null }
/** The account facts the app gates on (age, parental consent, AI consent). */
const gates = (u: AuthUser) => ({ ageGroup: u.ageGroup ?? null, guardianEmail: u.guardianEmail ?? null, guardianConsent: !!u.guardianConsentAt, ai: !u.aiOffAt }) // AI reading is on unless switched off

/** After sign-in/up: adopt the account's profile, upload anything made on this device before, then sync. */
export async function signedIn(u: AuthUser) {
  const local = getState()
  const firstOnDevice = !local.user
  // Different account (or an outbox restored from native storage that belonged to someone else): don't leak data across.
  const owner = local.user?.id ?? localStorage.getItem(WKEY)?.replace(/"/g, '')
  if (owner && owner !== u.id) { outbox = []; issues = []; saveOutbox(); saveIssues() }
  setCursor(null)
  setRemote(d => {
    if (local.user && local.user.id !== u.id) Object.assign(d, structuredClone(blank))
    d.user = { id: u.id, email: u.email, emailVerified: !!u.emailVerified, image: u.image, ...gates(u) }
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
  if (u) setRemote(d => { if (d.user) Object.assign(d.user, { email: u.email, emailVerified: u.emailVerified, image: u.image, ...gates(u as AuthUser) }); d.me.name = u.name || d.me.name })
  return u
}

export async function signOut() {
  await authClient.signOut().catch(() => {})
  token.clear()
  outbox = []; issues = []
  saveOutbox(); saveIssues(); setCursor(null)
  for (const k of Object.keys(localStorage)) if (k.startsWith('plico-chat:')) localStorage.removeItem(k) // Ask Plico history lives on the device only
  setRemote(d => { Object.assign(d, structuredClone(blank)) })
  snap = getState()
  setStatus({ authed: false, error: '' })
}

/** Wire up once at boot. */
export function startSync() {
  // The store hydrates from IndexedDB before this runs: start from what it loaded.
  snap = getState()
  status = { ...status, authed: !!getState().user }
  setCursor(null) // a full pull at every launch: cheap insurance against anything a delta could have missed
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
    .then(c => setStatus({ google: !!c.google, googleWebClientId: c.googleWebClientId, googleIosClientId: c.googleIosClientId, ai: !!c.ai, ...(c.push && { push: c.push }) })).catch(() => {})
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
  void restoreDurable().then(() => { setStatus({}); return flush() }).then(pull)
}
