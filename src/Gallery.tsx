import { useEffect, useState, type ReactNode } from 'react'
import { ME, balances, simplify } from './logic'
import { THEMES, ensureFonts, themeVars, type ThemeDef, type ThemeId } from './themes'
import { GroupView, Home, Seal, Settle, Wordmark } from './ui'
import { DEMO } from './demo'

const goa = DEMO.groups[0]
const karanOwes = simplify(balances(goa)).find(d => d.to === ME) ?? { from: 'karan', to: ME, amount: 184200 }
const face = (f: string) => f.replace(/'/g, '')

function Phone({ label, children }: { label: string; children: ReactNode }) {
  // Content is inert so clicks, taps and tab stops never escape the preview; the frame itself scrolls.
  return (
    <figure className="phone">
      <div className="phone-screen">
        <div className="phone-scroll" tabIndex={0} aria-label={`${label} screen preview, scrollable`}>
          <div inert>{children}</div>
        </div>
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  )
}

function ThemeSection({ t }: { t: ThemeDef }) {
  const [replay, setReplay] = useState(0)
  const c = t.c
  return (
    <section className="g-theme" id={`t-${t.id}`} aria-labelledby={`h-${t.id}`}>
      <div className="g-meta">
        <div>
          <h2 id={`h-${t.id}`} style={{ fontFamily: `${t.num}, serif` }}>{t.name}</h2>
          <p>{t.line}</p>
          <p className="g-spec">{face(t.ui)}{t.ui !== t.num && ` + ${face(t.num)}`} · radius {t.radius}px · stroke {t.stroke} · {t.motion} motion · {t.dark ? 'dark' : 'light'}</p>
        </div>
        <ul className="swatches" aria-label="Palette">
          {([['canvas', c.bg], ['surface', c.surface], ['accent', c.accent], ['owed to you', c.pos], ['you owe', c.neg], ['settled', c.settled]] as const).map(([n, v]) => (
            <li key={n} title={`${n} ${v}`}><span style={{ background: v }} /><small>{n}</small></li>
          ))}
        </ul>
      </div>
      <div className="g-phones">
        <Phone label="Home"><Home s={DEMO} t={t.id} /></Phone>
        <Phone label="Group"><GroupView s={DEMO} g={goa} t={t.id} /></Phone>
        <Phone label="Settle"><Settle s={DEMO} g={goa} {...karanOwes} t={t.id} /></Phone>
        <figure className="phone">
          <div className="g-seal" data-theme={t.id} style={themeVars(t.id)}>
            <Seal t={t.id} replay={replay} />
            <button className="btn secondary" onClick={() => setReplay(r => r + 1)}>Replay</button>
          </div>
          <figcaption>Settled moment</figcaption>
        </figure>
      </div>
    </section>
  )
}

export default function Gallery() {
  useEffect(() => ensureFonts(THEMES.map(t => t.id)), [])
  const jump = (id: ThemeId) => document.getElementById(`t-${id}`)?.scrollIntoView({ behavior: 'smooth' })
  return (
    <div className="gallery" data-theme="classic" style={themeVars('classic')}>
      <header className="g-head">
        <Wordmark />
        <h1>Twelve themes, one ledger.</h1>
        <p>
          Each theme changes type, shape, texture, icon stroke, motion and the moment a group settles. What money means never changes:
          green is owed to you, red is what you owe, and the settled colour marks only things that are settled.
          Every pair passes WCAG AA. Screens are real components running on sample data.
        </p>
        <nav className="g-index" aria-label="Jump to theme">
          {THEMES.map(t => (
            <button key={t.id} onClick={() => jump(t.id)}>
              <span className="sw" style={{ background: t.c.bg, boxShadow: `inset 0 0 0 7px ${t.c.accent}` }} />{t.name}
            </button>
          ))}
        </nav>
      </header>
      {THEMES.map(t => <ThemeSection key={t.id} t={t} />)}
    </div>
  )
}
