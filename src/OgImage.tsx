// The share card (og:image) at #/og, dev only: the wordmark, the landing hero's headline, and the real Home screen
// (Screen + Sidebar + Home from ui.tsx, desktop layout) filled with the gallery's sample groups from demo.ts.
// Capture: node ~/.claude/skills/og-image/scripts/capture.mjs --url 'http://localhost:5173/#/og' --out public/og.png
import { useEffect } from 'react'
import { DEMO } from './demo'
import { ME, allocate } from './logic'
import type { State } from './store'
import { ensureFonts, themeVars } from './themes'
import { Home, Wordmark } from './ui'

// Sample people get emails so Home's People and Needs you rails fill in, as they do for real friends. For the card,
// you paid this month's rent (so the hero is money coming back) and August's rent gives "This month" something to compare.
const flat = [ME, 'aditi', 'rohan', 'kunal']
const august = { id: 'og-aug', title: 'August rent', cat: 'rent', date: '2026-08-01', amount: 5400000, paid: { aditi: 5400000 }, owed: allocate(5400000, Object.fromEntries(flat.map(m => [m, 1]))), mode: 'equal' as const }
const SAMPLE: State = {
  ...DEMO,
  user: { id: 'sample', email: 'arjun.sharma@gmail.com', ageGroup: 'adult', onboarded: true },
  groups: DEMO.groups.map(g => ({
    ...g,
    members: g.members.map(m => (m.id === ME ? m : { ...m, email: `${m.id}@example.in` })),
    expenses: g.id !== 'flat' ? g.expenses : [august, ...g.expenses.map(e => (e.cat === 'rent' ? { ...e, paid: { [ME]: e.amount } } : e))],
  })),
}

const ZOOM = 0.8
const css = `
.og { position: relative; width: 1200px; height: 630px; overflow: hidden; background: var(--bg); color: var(--ink); }
.og::before { content: ''; position: absolute; left: 50%; top: -220px; width: 900px; height: 520px; translate: -50% 0; border-radius: 50%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--brand) 16%, transparent), transparent); }
.og-top { position: absolute; inset: 44px 0 auto; display: grid; justify-items: center; gap: 14px; }
.og-top .wordmark { font-size: 2rem; padding-left: 0; }
.og-top h1 { font: 800 72px/1 'Gabarito', var(--ui); letter-spacing: -.04em; white-space: nowrap; }
.og-win { position: absolute; zoom: ${ZOOM}; top: ${218 / ZOOM}px; left: ${60 / ZOOM}px; width: ${1080 / ZOOM}px; height: 640px; overflow: hidden;
  transform: translateZ(0); border-radius: 18px 18px 0 0; background: var(--bg); box-shadow: 0 0 0 1px var(--line), 0 24px 60px -18px rgb(23 23 28 / .28); }
.og-win .screen { min-height: 0; }
`

export default function OgImage() {
  useEffect(() => ensureFonts(['classic', ...SAMPLE.groups.map(g => g.theme)]), [])
  return (
    <div className="og" data-og-frame data-theme="classic" style={themeVars('classic')}>
      <style>{css}</style>
      <div className="og-top">
        <Wordmark />
        <h1>Hisaab sorted.</h1>
      </div>
      <div className="og-win" inert>
        <Home s={SAMPLE} t="classic" preview />
      </div>
    </div>
  )
}
