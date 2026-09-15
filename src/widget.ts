// Home-screen widget data. The app keeps a small, already formatted summary in native storage
// (Capacitor Preferences, key "widget"); the Android widget reads it directly, iOS copies it into the
// App Group when Plico goes to the background (SceneDelegate) and reloads the widget.
import { Capacitor } from '@capacitor/core'
import { ME, balances, inr } from './logic'
import { getState, subscribe, type State } from './store'

type Row = { name: string; emoji: string; amount: string; tone: 'pos' | 'neg' }
export type WidgetData = { title: string; amount: string; tone: 'pos' | 'neg' | 'even'; groups: Row[]; signedIn: boolean }

export function widgetData(s: State): WidgetData {
  const rows = s.groups.filter(g => !g.track).map(g => ({ g, net: balances(g)[ME] ?? 0 }))
  const net = rows.reduce((a, r) => a + r.net, 0)
  return {
    signedIn: !!s.user,
    title: !net ? 'All even' : net > 0 ? 'You’re owed' : 'You owe',
    amount: inr(net), tone: net > 0 ? 'pos' : net < 0 ? 'neg' : 'even',
    groups: rows.filter(r => r.net).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 3)
      .map(({ g, net }) => ({ name: g.name, emoji: g.emoji ?? '', amount: inr(net), tone: net > 0 ? 'pos' as const : 'neg' as const })),
  }
}

export function startWidget() {
  if (!Capacitor.isNativePlatform()) return
  let last = '', t: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    const v = JSON.stringify(widgetData(getState()))
    if (v === last) return
    last = v
    void import('@capacitor/preferences').then(({ Preferences }) => Preferences.set({ key: 'widget', value: v }))
  }
  subscribe(() => { clearTimeout(t); t = setTimeout(publish, 800) })
  publish()
}
