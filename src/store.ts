import { useSyncExternalStore } from 'react'
import { uid, type Group, type Theme, type Tone } from './logic'

export type State = {
  user?: { id: string; email: string; emailVerified?: boolean; image?: string | null; ageGroup?: string | null; guardianEmail?: string | null; guardianConsent?: boolean; ai?: boolean; onboarded?: boolean }
  me: { name: string; upi: string; upi2?: string; phone?: string }
  theme: Theme
  /** Show each group's own theme on its page (everything else always wears `theme`). Missing = on. */
  groupThemes?: boolean
  tone: Tone
  groups: Group[]
}

const KEY = 'splittr'
export const blank: State = { me: { name: '', upi: '' }, theme: 'classic', tone: 'gentle', groups: [] }

// Local cache of the server state; the sync outbox (sync.ts) carries edits up.
// Kept in IndexedDB (no ~5 MB localStorage ceiling). localStorage is the fallback where IndexedDB fails
// (some private modes) and the place older versions kept it, migrated on first launch.
function legacy(): State {
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return blank
  }
}

let idb: Promise<IDBDatabase> | undefined
const store = (mode: IDBTransactionMode) => (idb ??= new Promise((ok, no) => {
  const r = indexedDB.open('plico', 1)
  r.onupgradeneeded = () => r.result.createObjectStore('kv')
  r.onsuccess = () => ok(r.result)
  r.onerror = () => no(r.error)
})).then(d => d.transaction('kv', mode).objectStore('kv'))
const done = <T>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error) })
let useIdb = typeof indexedDB !== 'undefined'

let state = legacy()
const subs = new Set<() => void>()
let listener: ((prev: State, next: State) => void) | undefined

/** Load the saved state before the app starts (main.tsx waits for this). */
export async function hydrate() {
  if (!useIdb) return
  try {
    const saved = await done((await store('readonly')).get(KEY)) as State | undefined
    if (saved) state = { ...blank, ...saved }
    else if (localStorage.getItem(KEY)) await done((await store('readwrite')).put(state, KEY)) // move the old copy over
    localStorage.removeItem(KEY)
    void navigator.storage?.persist?.() // ask the browser not to evict us under storage pressure
  } catch {
    useIdb = false // stay on localStorage
  }
}

function commit(next: State) {
  state = next
  // Writes queue in order on one object store, so the last one wins.
  if (useIdb) store('readwrite').then(s => done(s.put(state, KEY))).catch(() => { useIdb = false; localStorage.setItem(KEY, JSON.stringify(state)) })
  else localStorage.setItem(KEY, JSON.stringify(state))
  subs.forEach(f => f())
}

export const getState = () => state
export const onLocalChange = (f: typeof listener) => { listener = f }

/** A user edit: saved locally at once, then queued for the server. */
export function update(fn: (s: State) => void) {
  const prev = state
  const next = structuredClone(state)
  fn(next)
  for (const g of next.groups) g.selfId ||= uid()
  commit(next)
  listener?.(prev, next)
}

/** Apply state that came from the server (or sign-in/out). Never queued back up. */
export function setRemote(fn: (s: State) => void) {
  const next = structuredClone(state)
  fn(next)
  commit(next)
}

export const subscribe = (f: () => void) => (subs.add(f), () => { subs.delete(f) })
export const useStore = () => useSyncExternalStore(subscribe, () => state)
