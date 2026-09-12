import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { ME, balances, simplify, type Expense, inr, upiLink, isVpa, encodeShare, type Group, type Id, type Kind, type Transfer } from './logic'
import { update, type State } from './store'
import { THEMES, ensureFonts, theme, themeVars, type ThemeId } from './themes'
import { Icon, type IconName } from './icons'

// ---------- routing ----------
export function useRoute() {
  const [h, setH] = useState(location.hash)
  useEffect(() => {
    const f = () => { setH(location.hash); scrollTo(0, 0) }
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  return h.replace(/^#\/?/, '').split('/').filter(Boolean)
}
export const go = (p: string) => (location.hash = p)
const goBack = () => (history.length > 1 ? history.back() : go('/'))

// ---------- copy + names ----------
export const KINDS: Record<Kind, { label: string; theme: ThemeId; hint: string }> = {
  trip: { label: 'Trip', theme: 'goa', hint: "Goa '26" },
  home: { label: 'Home', theme: 'matcha', hint: 'Flat 404' },
  couple: { label: 'Couple', theme: 'midnight', hint: 'Us two' },
  friends: { label: 'Friends', theme: 'cyber', hint: 'Weekend gang' },
  office: { label: 'Office', theme: 'mono', hint: 'Team lunch' },
  family: { label: 'Family', theme: 'khata', hint: 'Sharma family' },
}
export const PUBLIC = import.meta.env.VITE_PUBLIC_URL || location.origin
export const who = (g: Group, id: Id) => (id === ME ? 'You' : g.members.find(m => m.id === id)?.name ?? 'Someone')
export const realName = (s: State, g: Group, id: Id) => (id === ME ? s.me.name || 'Me' : who(g, id))
export const upiOf = (s: State, g: Group, id: Id) => (id === ME ? s.me.upi : g.members.find(m => m.id === id)?.upi) ?? ''
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const lower = (name: string) => (name === 'You' ? 'you' : name)
const tone = (p: number) => (p > 0 ? 'pos' : p < 0 ? 'neg' : '')

export function verb(g: Group | null, net: number, overall = false) {
  if (!net) return overall ? 'All even. Nothing to settle.' : 'Everyone’s even here.'
  if (g?.kind === 'couple') return net > 0 ? 'You covered more this month' : 'They covered more this month'
  return net > 0 ? (overall ? 'You’re owed overall' : 'You’re owed') : overall ? 'You owe overall' : 'You owe'
}
const verbShort = (g: Group, net: number) =>
  !net ? 'even' : g.kind === 'couple' ? (net > 0 ? 'you covered more' : 'they covered more') : net > 0 ? 'you’re owed' : 'you owe'

export const TONES = {
  gentle: (a: string, to: string, g: string) => `Tiny reminder: ${a} for ${to} from ${g} is still hanging around 👀`,
  normal: (a: string, to: string, g: string) => `${g}: ${a} still pending to ${to}.`,
  shameless: (a: string, to: string, g: string) => `${g} is over. The ${a} subplot continues. It goes to ${to}.`,
}
export const shareLink = (s: State, g: Group, t: Transfer) =>
  `${PUBLIC}/#/s/${encodeShare({ g: g.name, f: realName(s, g, t.from), t: realName(s, g, t.to), v: upiOf(s, g, t.to) || undefined, a: t.amount })}`
export const reminder = (s: State, g: Group, t: Transfer) =>
  `${TONES[s.tone](inr(t.amount), realName(s, g, t.to), g.name)}\nPay here: ${shareLink(s, g, t)}`
export const wa = (text: string) => 'https://wa.me/?text=' + encodeURIComponent(text)

// ---------- ornaments (crisp vector geometry, not pictures) ----------
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
function spiro(R: number, r: number, d: number) {
  const k = (R - r) / r, turns = r / gcd(R, r), n = 360 * turns
  let s = ''
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI * turns
    s += (i ? 'L' : 'M') + ((R - r) * Math.cos(t) + d * Math.cos(k * t)).toFixed(1) + ' ' + ((R - r) * Math.sin(t) - d * Math.sin(k * t)).toFixed(1)
  }
  return s
}
const ROSETTE = [spiro(96, 36, 50), spiro(100, 24, 46), spiro(60, 22, 30)]

export function Ornament({ t }: { t: ThemeId }) {
  const o = theme(t).ornament
  // Pieces coming together: two soft halves drift in and overlap, Plico's motif at hero scale.
  if (o === 'pieces')
    return (
      <svg className="ornament pieces" viewBox="-150 -150 300 300" aria-hidden>
        <circle className="pc-a" cx="-34" cy="-10" r="92" />
        <circle className="pc-b" cx="46" cy="18" r="70" />
        <circle className="pc-c" cx="-6" cy="96" r="30" />
      </svg>
    )
  if (o === 'guilloche')
    return <svg className="ornament" viewBox="-150 -150 300 300" aria-hidden>{ROSETTE.map(d => <path key={d.length} d={d} pathLength={1} />)}</svg>
  if (o === 'ripple')
    return <svg className="ornament" viewBox="-150 -150 300 300" aria-hidden>{[28, 52, 76, 100, 124, 148].map(r => <circle key={r} r={r} />)}</svg>
  return null
}

// Plico's body is the brand: a purple stem and a rounder bowl that overlap into a soft "p".
// The stem is always Plico Purple (--brand); the bowl takes the theme's accent, so every theme re-skins Plico.
const STEM = <rect className="pl-stem" x="4" y="4" width="10" height="25" rx="5" />
const BOWL = <circle className="pl-bowl-body" cx="18" cy="13" r="10" />

export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="brandmark plico-shape">
      <g className="pl-bowl">{BOWL}</g>{STEM}
    </svg>
  )
}

export const Wordmark = () => <span className="wordmark" role="img" aria-label="plico"><BrandMark /><span aria-hidden>lico</span></span>

export type Mood = 'idle' | 'owed' | 'owe' | 'settled' | 'empty' | 'thinking'
/** Plico, the mascot. Appears in onboarding, empty states, settling, loading and errors; never parked on money. */
export function Plico({ mood = 'idle', size = 64 }: { mood?: Mood; size?: number }) {
  const closed = mood === 'empty'
  return (
    <svg width={size} height={size} viewBox="-2 -3 36 36" aria-hidden className={`plico plico-shape is-${mood}`}>
      {mood === 'settled' && <g className="pl-sparks">{[[-1, 2], [31, 3], [30, 26], [0, 27]].map(([x, y]) => <path key={x + '' + y} d={`M${x} ${y - 2.5}v5M${x - 2.5} ${y}h5`} />)}</g>}
      <g className="pl-bowl">
        {BOWL}
        <g className="pl-face">
          {closed ? <path className="pl-lids" d="M16.2 12.8q1.4 1.3 2.8 0M21.8 12.8q1.4 1.3 2.8 0" />
            : <g className="pl-eyes"><circle cx="17.6" cy="12.4" r="1.7" /><circle cx="23.2" cy="12.4" r="1.7" /></g>}
          {(mood === 'settled' || closed) && <path className="pl-mouth" d="M18.4 16.4q2 1.8 4 0" />}
        </g>
      </g>
      {STEM}
    </svg>
  )
}

// ---------- primitives ----------
export function Money({ p, sign, className = '' }: { p: number; sign?: boolean; className?: string }) {
  return <span className={`money ${tone(p)} ${className}`}>{sign && p > 0 ? '+' : sign && p < 0 ? '−' : ''}{inr(p)}</span>
}

export function Screen({ t, title, back, action, fab, children }: {
  t: ThemeId; title?: ReactNode; back?: boolean | (() => void); action?: ReactNode; fab?: string; children: ReactNode
}) {
  return (
    <div className="screen" data-theme={t} style={themeVars(t)}>
      <header className="bar">
        {back ? <button className="iconbtn" onClick={typeof back === 'function' ? back : goBack} aria-label="Back"><Icon n="back" /></button>
          : <Wordmark />}
        {title && <h1 className="bar-title">{title}</h1>}
        <span className="bar-end">{action}</span>
      </header>
      <main className="main">{children}</main>
      {fab && (
        <nav className="dock" aria-label="Main">
          <button className="dock-item" onClick={() => go('/')}><Icon n="home" />Home</button>
          <button className="fab" onClick={() => go(fab)} aria-label="Add expense"><Icon n="plus" size={28} /></button>
          <button className="dock-item" onClick={() => go('/me')}><Icon n="user" />You</button>
        </nav>
      )}
    </div>
  )
}

export const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/** Counts a money value from what was shown to its new value, so a changed balance reads as a change. */
export function useTicker(value: number, ms = 700) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value || calm()) { from.current = value; return setShown(value) }
    let raf = 0
    const t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      const v = Math.round(start + (value - start) * (1 - Math.pow(2, -10 * k)) / (1 - Math.pow(2, -10)))
      from.current = k < 1 ? v : value
      setShown(k < 1 ? v : value)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return shown
}

export function Denomination({ t, amount, line, caption }: { t: ThemeId; amount: number; line: string; caption?: ReactNode }) {
  const shown = useTicker(amount)
  const digits = inr(shown).replace('₹', '')
  // Size to the final value so the numeral doesn't resize while it counts.
  const chars = inr(amount).length - 1
  return (
    <section className="hero" aria-label={`${line}: ${inr(amount)}`}>
      <Ornament t={t} />
      <p className={`hero-num ${tone(amount)}`} aria-hidden style={{ '--chars': chars } as CSSProperties}><span className="cur">₹</span>{digits}</p>
      <p className="hero-verb" aria-hidden>{line}</p>
      {caption && <p className="hero-cap">{caption}</p>}
    </section>
  )
}

const Peaceful = () => (
  <div className="peaceful"><Plico mood="empty" size={64} /><p><strong>Suspiciously peaceful in here.</strong>Add the first expense with +.</p></div>
)

export const SectionHead = ({ title, action }: { title: string; action?: ReactNode }) => (
  <div className="section-head"><h2>{title}</h2>{action}</div>
)

export function Seal({ t, replay = 0, caption = 'Everyone’s even ✨' }: { t: ThemeId; replay?: number; caption?: string }) {
  const id = useId()
  const th = theme(t)
  const ring = `${th.celebrate} · plico · ${th.celebrate} · plico · `.toUpperCase()
  return (
    <div className="seal" key={replay} role="status">
      <svg className="seal-svg" viewBox="-60 -60 120 120" aria-hidden>
        <defs><path id={id} d="M-44 0a44 44 0 1 1 88 0a44 44 0 1 1-88 0" /></defs>
        {(th.ornament === 'ripple' || t === 'midnight') && <g className="seal-ripples">{[20, 20, 20].map((r, i) => <circle key={i} r={r} style={{ animationDelay: `${i * 180}ms` }} />)}</g>}
        {th.radius === 0 ? <><rect className="seal-outer" x="-54" y="-54" width="108" height="108" /><rect className="seal-inner" x="-34" y="-34" width="68" height="68" /></>
          : <><circle className="seal-outer" r="56" /><circle className="seal-inner" r="36" /></>}
        <text className="seal-text"><textPath href={`#${id}`} textLength="272">{ring}</textPath></text>
        <g className="seal-plico" transform="translate(-17 -17) scale(1.05)"><g className="pl-bowl">{BOWL}<circle className="pl-eye" cx="17.6" cy="12.4" r="1.7" /><circle className="pl-eye" cx="23.2" cy="12.4" r="1.7" /><path className="pl-smile" d="M18.4 16.4q2 1.8 4 0" /></g>{STEM}</g>
        {t === 'chai' && <g className="seal-steam">{[-10, 0, 10].map(x => <path key={x} d={`M${x} -62c-5 -6 5 -10 0 -16s5 -10 0 -16`} />)}</g>}
      </svg>
      <p className="seal-caption"><span className="seal-word">{th.celebrate}.</span> {caption}</p>
    </div>
  )
}

/** UPI QR as a data URL, always dark-on-white for scanner reliability. */
export function useQr(link: string) {
  const [qr, setQr] = useState('')
  useEffect(() => {
    if (!link) return setQr('')
    let live = true
    QRCode.toDataURL(link, { margin: 1, width: 480, color: { dark: '#000000', light: '#ffffff' } }).then(u => live && setQr(u))
    return () => { live = false }
  }, [link])
  return qr
}

export function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (t: ThemeId) => void }) {
  useEffect(() => ensureFonts(THEMES.map(t => t.id)), [])
  return (
    <div className="themes" role="radiogroup" aria-label="Theme">
      {THEMES.map(t => (
        <button type="button" key={t.id} role="radio" aria-checked={t.id === value} className="swatch" data-theme={t.id} style={themeVars(t.id)} onClick={() => onChange(t.id)}>
          <span className="swatch-num">₹840</span>
          <span className="swatch-name">{t.name}</span>
        </button>
      ))}
    </div>
  )
}

// ---------- screens ----------
export function LedgerRow({ g, e, serial, showGroup }: { g: Group; e: Group['expenses'][number]; serial: number; showGroup?: boolean }) {
  const mine = (e.paid[ME] ?? 0) - (e.owed[ME] ?? 0)
  const payers = Object.keys(e.paid)
  const by = payers.length > 1 ? `${payers.length} people` : who(g, payers[0])
  const no = `No. ${String(serial).padStart(4, '0')}`
  return (
    <li className="ledger-row">
      <button onClick={() => go(`/g/${g.id}/e/${e.id}`)}>
        <span className={`cat ${e.settle && !e.pending ? 'cat-settled' : ''}`}><Icon n={e.settle ? 'check' : (e.cat as IconName)} /></span>
        <span className="lr-body">
          <strong>{e.settle ? `${by} paid ${lower(who(g, Object.keys(e.owed)[0]))}` : e.title}</strong>
          <small><span className="serial">{no} · </span>{e.pending ? 'waiting to confirm' : e.settle ? 'settlement' : `${inr(e.amount)}, ${lower(by)} paid`}{showGroup ? ` · ${g.name}` : ''}</small>
        </span>
        {e.settle ? <span className="lr-amt"><span className={`money ${e.pending ? 'muted-ink' : 'settled-ink'}`}>{inr(e.amount)}</span></span>
          : <span className="lr-amt"><Money p={mine} sign /><small>{mine > 0 ? 'you lent' : mine < 0 ? 'your share' : 'not in it'}</small></span>}
      </button>
    </li>
  )
}

// ---------- settlements waiting for the payee ----------
const ends = (e: Expense) => ({ from: Object.keys(e.paid)[0], to: Object.keys(e.owed)[0] })
const setPending = (gid: Id, eid: Id, ok: boolean) => update(d => {
  const g = d.groups.find(x => x.id === gid)
  if (!g) return
  if (ok) { const e = g.expenses.find(x => x.id === eid); if (e) delete e.pending }
  else g.expenses = g.expenses.filter(x => x.id !== eid)
})

/** The payee's side: someone says they paid you. You're the only one who can say it arrived. */
export function ConfirmCard({ g, e, showGroup }: { g: Group; e: Expense; showGroup?: boolean }) {
  const { from } = ends(e)
  return (
    <li className="confirm-card">
      <p><strong>{who(g, from)} marked <span className="money">{inr(e.amount)}</span> as paid to you</strong>
        <small>{showGroup ? `${g.name} · ` : ''}Check your UPI app first.</small></p>
      <span className="debt-actions">
        <button className="btn-sm" onClick={() => setPending(g.id, e.id, true)}><Icon n="check" size={16} />Got it</button>
        <button className="btn-sm ghost" onClick={() => setPending(g.id, e.id, false)}>Not yet</button>
      </span>
    </li>
  )
}
const waitingFor = (g: Group) => g.expenses.filter(e => e.pending && ends(e).to === ME)

export function Home({ s, t, banner }: { s: State; t: ThemeId; banner?: ReactNode }) {
  const rows = s.groups.map(g => ({ g, net: balances(g)[ME] ?? 0 }))
  const live = rows.filter(r => !r.g.track)
  const total = live.reduce((a, r) => a + r.net, 0)
  const collect = live.reduce((a, r) => a + Math.max(r.net, 0), 0)
  const pay = live.reduce((a, r) => a + Math.max(-r.net, 0), 0)
  const recent = s.groups
    .flatMap(g => g.expenses.map((e, i) => ({ g, e, i })))
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
    .slice(0, 6)
  return (
    <Screen t={t} fab="/add" action={<button className="iconbtn" aria-label="You and settings" onClick={() => go('/me')}><Icon n="user" /></button>}>
      <Denomination t={t} amount={total} line={verb(null, total, true)}
        caption={collect && pay ? `${inr(collect)} to collect · ${inr(pay)} to pay` : undefined} />
      {banner}
      {s.groups.some(g => waitingFor(g).length) && <>
        <SectionHead title="To confirm" />
        <ol className="debts">{s.groups.flatMap(g => waitingFor(g).map(e => <ConfirmCard key={e.id} g={g} e={e} showGroup />))}</ol>
      </>}
      <SectionHead title="Groups" action={<button className="link" onClick={() => go('/new')}>New group</button>} />
      <ol className="slips">
        {rows.map(({ g, net }, i) => {
          const gt = theme(g.theme)
          return (
            <li key={g.id} style={{ '--i': i, '--gnum': `${gt.num}, ${gt.ui}, system-ui` } as CSSProperties}>
              <button className="slip" onClick={() => go('/g/' + g.id)}>
                <span className="slip-kind" style={{ background: gt.c.accent, color: gt.c.onAccent }}><Icon n={g.kind} /></span>
                <span className="slip-body">
                  <span className="serial">No. {String(i + 1).padStart(2, '0')}</span>
                  <strong>{g.name}</strong>
                  <small>{count(g.members.length, 'person', 'people')} · {count(g.expenses.filter(e => !e.settle).length, 'expense', 'expenses')}</small>
                </span>
                <span className="slip-amt">{net ? <Money p={net} /> : <span className="money settled-ink"><Icon n="check" size={20} /></span>}<small>{g.track ? 'tracking' : verbShort(g, net)}</small></span>
              </button>
            </li>
          )
        })}
      </ol>
      <SectionHead title="Recent" />
      {recent.length ? (
        <ol className="ledger">
          {recent.map(({ g, e, i }) => <LedgerRow key={e.id} g={g} e={e} serial={i + 1} showGroup />)}
        </ol>
      ) : <Peaceful />}
    </Screen>
  )
}

function SpendBar({ g }: { g: Group }) {
  const spent = g.expenses.filter(e => !e.settle)
  const total = spent.reduce((a, e) => a + e.amount, 0)
  const cats = Object.entries(spent.reduce<Record<string, number>>((m, e) => ((m[e.cat] = (m[e.cat] ?? 0) + e.amount), m), {})).sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (!total) return null
  const fill = (i: number) => `color-mix(in srgb, var(--accent) ${100 - i * 18}%, var(--surface2))`
  return (
    <figure className="spend" aria-label={`Spending by category: ${cats.map(([c, v]) => `${c} ${inr(v)}`).join(', ')}`}>
      <div className="spend-bar" aria-hidden>{cats.map(([c, v], i) => <span key={c} style={{ flexGrow: v, background: fill(i) }} />)}</div>
      <ul className="spend-legend" aria-hidden>
        {cats.map(([c, v], i) => <li key={c}><span className="dot" style={{ background: fill(i) }} /><Icon n={c as IconName} size={16} />{inr(v)}</li>)}
      </ul>
    </figure>
  )
}

export function GroupView({ s, g, t = g.theme }: { s: State; g: Group; t?: ThemeId }) {
  const bal = balances(g)
  const net = bal[ME] ?? 0
  const spent = g.expenses.filter(e => !e.settle)
  const total = spent.reduce((a, e) => a + e.amount, 0)
  const share = spent.reduce((a, e) => a + (e.owed[ME] ?? 0), 0)
  const paid = spent.reduce((a, e) => a + (e.paid[ME] ?? 0), 0)
  const debts = simplify(bal)
  const toMe = debts.filter(d => d.to === ME)
  const confirmMine = waitingFor(g)
  const waiting = (d: Transfer) => g.expenses.find(e => e.pending && ends(e).from === d.from && ends(e).to === d.to)
  const list = g.expenses.map((e, i) => ({ e, i })).sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
  const remindAll = `Tiny reminder from ${g.name}:\n` + toMe.map(d => `${realName(s, g, d.from)}: ${inr(d.amount)} → ${shareLink(s, g, d)}`).join('\n')
  return (
    <Screen t={t} back title={g.name} fab={`/g/${g.id}/add`}
      action={<button className="iconbtn" aria-label="Group settings" onClick={() => go(`/g/${g.id}/edit`)}><Icon n="settings" /></button>}>
      <Denomination t={t} amount={net} line={g.track ? 'Tracking only, no nudges' : verb(g, net)}
        caption={<>{inr(total)} spent · your share {inr(share)} · you paid {inr(paid)}</>} />
      {spent.length > 0 && !debts.length && <Seal t={t} />}
      {confirmMine.length > 0 && <>
        <SectionHead title="To confirm" />
        <ol className="debts">{confirmMine.map(e => <ConfirmCard key={e.id} g={g} e={e} />)}</ol>
      </>}
      <SpendBar g={g} />
      {debts.length > 0 && <>
        <SectionHead title={g.track ? 'Balances' : 'Still to settle'}
          action={!g.track && toMe.length > 1 && <a className="link" href={wa(remindAll)} target="_blank" rel="noopener">Remind all</a>} />
        <ol className="debts">
          {debts.map(d => (
            <li className="debt" key={d.from + d.to}>
              <span className="debt-flow">
                <span className="who">{who(g, d.from)}</span>
                <span className="flow-arrow" role="img" aria-label="pays"><Icon n="arrow" size={18} /></span>
                <span className="who">{who(g, d.to)}</span>
              </span>
              <span className={`money ${d.to === ME ? 'pos' : d.from === ME ? 'neg' : ''}`}>{inr(d.amount)}</span>
              {!g.track && waiting(d) && d.to !== ME ? <small className="debt-wait">Paid {inr(waiting(d)!.amount)}. Waiting for {who(g, d.to)} to confirm.</small> : !g.track && (
                <span className="debt-actions">
                  <button className="btn-sm" onClick={() => go(`/g/${g.id}/pay/${d.from}/${d.to}/${d.amount}`)}>Settle</button>
                  {d.to === ME && <a className="btn-sm ghost" href={wa(reminder(s, g, d))} target="_blank" rel="noopener"><Icon n="bell" size={16} />Remind</a>}
                </span>
              )}
            </li>
          ))}
        </ol>
      </>}
      <SectionHead title="Expenses" />
      {list.length ? <ol className="ledger">{list.map(({ e, i }) => <LedgerRow key={e.id} g={g} e={e} serial={i + 1} />)}</ol>
        : <Peaceful />}
    </Screen>
  )
}

export function Settle({ s, g, from, to, amount, t = g.theme, onRecord }: {
  s: State; g: Group; from: Id; to: Id; amount: number; t?: ThemeId; onRecord?: (paise: number, vpa: string) => void
}) {
  const payee = realName(s, g, to)
  const vpa = upiOf(s, g, to)
  const [asked, setAsked] = useState(false)
  const note = `${g.name} settlement`
  const link = isVpa(vpa) ? upiLink(vpa, payee, amount, note) : ''
  const qr = useQr(link)
  return (
    <Screen t={t} back title="Settle up">
      <section className="pay" aria-label="Payment details">
        <p className="pay-who">{who(g, from) === 'You' ? 'You are paying' : `${who(g, from)} is paying`}</p>
        <p className="payee">{payee}</p>
        {vpa ? <code className="vpa">{vpa}</code> : <p className="pay-who">No UPI ID yet. Add one in group settings.</p>}
        <p className="pay-amt"><span className={`money ${to === ME ? 'pos' : from === ME ? 'neg' : ''}`}>{inr(amount)}</span></p>
        <p className="pay-for">For {note}</p>
        {qr && <div className="qr-plate"><img src={qr} alt={`UPI QR code to pay ${payee} ${inr(amount)}`} /></div>}
      </section>
      {link && <a className="btn primary" href={link} onClick={() => setAsked(true)}><Icon n="send" />Pay {inr(amount)} via UPI</a>}
      {from !== ME && <a className="btn secondary" href={wa(reminder(s, g, { from, to, amount }))} target="_blank" rel="noopener"><Icon n="bell" />Send on WhatsApp</a>}
      <p className="note"><Icon n="check" size={18} /><span>Check that your UPI app shows <strong>{payee}</strong> before you pay.</span></p>
      {asked ? (
        <div className="confirm" role="group" aria-label="Payment result">
          <p>Did your {inr(amount)} payment to {payee} go through?</p>
          <div className="row">
            <button className="btn primary" onClick={() => onRecord?.(amount, vpa)}>Yes, paid</button>
            <button className="btn secondary" onClick={() => setAsked(false)}>Not yet</button>
          </div>
        </div>
      ) : (
        <button className="link center-link" onClick={() => onRecord?.(amount, vpa)}><Icon n="cash" size={18} />Paid in cash or another way</button>
      )}
    </Screen>
  )
}
