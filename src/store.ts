import { useSyncExternalStore } from 'react'
import { uid, type Group, type Theme, type Tone } from './logic'

export type State = {
  user?: { id: string; email: string; emailVerified?: boolean; image?: string | null }
  me: { name: string; upi: string; phone?: string }
  theme: Theme
  tone: Tone
  groups: Group[]
}

const KEY = 'splittr'
export const blank: State = { me: { name: '', upi: '' }, theme: 'classic', tone: 'gentle', groups: [] }

// Local cache of the server state; the sync outbox (sync.ts) carries edits up.
// ponytail: whole state in one localStorage key (~5MB ceiling); move to IndexedDB if groups get huge.
function load(): State {
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return blank
  }
}

let state = load()
const subs = new Set<() => void>()
let listener: ((prev: State, next: State) => void) | undefined

function commit(next: State) {
  state = next
  localStorage.setItem(KEY, JSON.stringify(state))
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
