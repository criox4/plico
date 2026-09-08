import { useSyncExternalStore } from 'react'
import { runRecurring, type Group, type Theme, type Tone } from './logic'

export type State = { me: { name: string; upi: string }; theme: Theme; tone: Tone; groups: Group[] }

const KEY = 'splittr'
const blank: State = { me: { name: '', upi: '' }, theme: 'clean', tone: 'gentle', groups: [] }

// ponytail: whole state in one localStorage key (~5MB ceiling); move to IndexedDB + sync when a backend lands.
function load(): State {
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(KEY) || '{}') }
  } catch {
    return blank
  }
}

let state = load()
const subs = new Set<() => void>()

export function update(fn: (s: State) => void) {
  const next = structuredClone(state)
  fn(next)
  state = next
  localStorage.setItem(KEY, JSON.stringify(state))
  subs.forEach(f => f())
}

export function replaceAll(s: State) {
  update(d => Object.assign(d, blank, s))
}

export const useStore = () =>
  useSyncExternalStore(
    f => (subs.add(f), () => subs.delete(f)),
    () => state,
  )

// Catch up monthly repeats on launch.
if (state.groups.some(g => g.expenses.some(e => e.repeat))) update(s => s.groups.forEach(g => runRecurring(g)))
