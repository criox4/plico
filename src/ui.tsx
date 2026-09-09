import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { ME, balances, simplify, inr, upiLink, isVpa, encodeShare, type Group, type Id, type Kind, type Transfer } from './logic'
import type { State } from './store'
import { theme, themeVars, type ThemeId } from './themes'
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
const tone = (p: number) => (p > 0 ? 'pos' : p < 0 ? 'neg' : '')

export function verb(g: Group | null, net: number, overall = false) {
  if (!net) return overall ? 'All square. Nothing pending.' : 'All square in this group.'
  if (g?.kind === 'couple') return net > 0 ? 'You covered more this month' : 'They covered more this month'
  return net > 0 ? (overall ? 'You are owed overall' : 'You are owed') : overall ? 'You owe overall' : 'You owe'
}
const verbShort = (g: Group, net: number) =>
  !net ? 'settled' : g.kind === 'couple' ? (net > 0 ? 'you covered more' : 'they covered more') : net > 0 ? 'you are owed' : 'you owe'

export const TONES = {
  gentle: (a: string, to: string, g: string) => `Tiny reminder: ${a} is still pending with ${to} from ${g}.`,
  normal: (a: string, to: string, g: string) => `${g}: ${a} settlement pending with ${to}.`,
  shameless: (a: string, to: string, g: string) => `${g} ended. Your debt apparently didn't. ${a} to ${to}.`,
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
  if (o === 'guilloche')
    return <svg className="ornament" viewBox="-150 -150 300 300" aria-hidden>{ROSETTE.map(d => <path key={d.length} d={d} />)}</svg>
  if (o === 'ripple')
    return <svg className="ornament" viewBox="-150 -150 300 300" aria-hidden>{[28, 52, 76, 100, 124, 148].map(r => <circle key={r} r={r} />)}</svg>
  return null
}

export function BrandMark({ size = 26 }: { size?: number }) {
  // Splittr mark: one coin, split. Always Splittr Indigo, in every theme.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="brandmark">
      <path d="M14.5 3.1A13 13 0 0 0 14.5 28.9z" fill="var(--brand)" />
      <path d="M17.5 3.1A13 13 0 0 1 17.5 28.9z" fill="var(--brand)" opacity=".55" />
    </svg>
  )
}

// ---------- primitives ----------
export function Money({ p, sign, className = '' }: { p: number; sign?: boolean; className?: string }) {
  return <span className={`money ${tone(p)} ${className}`}>{sign && p > 0 ? '+' : sign && p < 0 ? '−' : ''}{inr(p)}</span>
}

export function Screen({ t, title, back, action, fab, children }: {
  t: ThemeId; title?: ReactNode; back?: boolean; action?: ReactNode; fab?: string; children: ReactNode
}) {
  return (
    <div className="screen" data-theme={t} style={themeVars(t)}>
      <header className="bar">
        {back ? <button className="iconbtn" onClick={goBack} aria-label="Back"><Icon n="back" /></button>
          : <span className="wordmark"><BrandMark />Splittr</span>}
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

export function Denomination({ t, amount, line, caption }: { t: ThemeId; amount: number; line: string; caption?: ReactNode }) {
  const digits = inr(amount).replace('₹', '')
  return (
    <section className="hero" aria-label={`${line}: ${inr(amount)}`}>
      <Ornament t={t} />
      <p className={`hero-num ${tone(amount)}`} aria-hidden style={{ '--chars': digits.length } as CSSProperties}><span className="cur">₹</span>{digits}</p>
      <p className="microprint" aria-hidden>{'SPLITTR · SETTLE · '.repeat(8)}</p>
      <p className="hero-verb" aria-hidden>{line}</p>
      {caption && <p className="hero-cap">{caption}</p>}
    </section>
  )
}

const SectionHead = ({ title, action }: { title: string; action?: ReactNode }) => (
  <div className="section-head"><h2>{title}</h2>{action}</div>
)

export function Seal({ t, replay = 0, caption = 'Everyone is square in this group.' }: { t: ThemeId; replay?: number; caption?: string }) {
  const id = useId()
  const th = theme(t)
  const ring = `${th.celebrate} · Splittr · ${th.celebrate} · Splittr · `.toUpperCase()
  return (
    <div className="seal" key={replay} role="status">
      <svg className="seal-svg" viewBox="-60 -60 120 120" aria-hidden>
        <defs><path id={id} d="M-44 0a44 44 0 1 1 88 0a44 44 0 1 1-88 0" /></defs>
        {(th.ornament === 'ripple' || t === 'midnight') && <g className="seal-ripples">{[20, 20, 20].map((r, i) => <circle key={i} r={r} style={{ animationDelay: `${i * 180}ms` }} />)}</g>}
        {th.radius === 0 ? <><rect className="seal-outer" x="-54" y="-54" width="108" height="108" /><rect className="seal-inner" x="-34" y="-34" width="68" height="68" /></>
          : <><circle className="seal-outer" r="56" /><circle className="seal-inner" r="36" /></>}
        <g className="seal-rosette" transform="scale(.3)"><path d={ROSETTE[2]} /></g>
        <text className="seal-text"><textPath href={`#${id}`} textLength="272">{ring}</textPath></text>
        <path className="seal-check" d="M-13 1l8 8 18-18" />
        {t === 'chai' && <g className="seal-steam">{[-10, 0, 10].map(x => <path key={x} d={`M${x} -62c-5 -6 5 -10 0 -16s5 -10 0 -16`} />)}</g>}
      </svg>
      <p className="seal-caption"><span className="seal-word">{th.celebrate}.</span> {caption}</p>
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
        <span className={`cat ${e.settle ? 'cat-settled' : ''}`}><Icon n={e.settle ? 'check' : (e.cat as IconName)} /></span>
        <span className="lr-body">
          <strong>{e.settle ? `${by} paid ${who(g, Object.keys(e.owed)[0])}` : e.title}</strong>
          <small><span className="serial">{no}</span> · {e.settle ? 'settlement' : `${inr(e.amount)}, ${by} paid`}{showGroup ? ` · ${g.name}` : ''}</small>
        </span>
        {e.settle ? <span className="lr-amt"><span className="money settled-ink">{inr(e.amount)}</span></span>
          : <span className="lr-amt"><Money p={mine} sign /><small>{mine > 0 ? 'you lent' : mine < 0 ? 'your share' : 'not in it'}</small></span>}
      </button>
    </li>
  )
}

export function Home({ s, t }: { s: State; t: ThemeId }) {
  const rows = s.groups.map(g => ({ g, net: balances(g)[ME] ?? 0 }))
  const total = rows.reduce((a, r) => a + (r.g.track ? 0 : r.net), 0)
  const recent = s.groups
    .flatMap(g => g.expenses.map((e, i) => ({ g, e, i })))
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
    .slice(0, 6)
  return (
    <Screen t={t} fab="/add" action={<button className="iconbtn" aria-label="You and settings" onClick={() => go('/me')}><Icon n="user" /></button>}>
      <Denomination t={t} amount={total} line={verb(null, total, true)} />
      <SectionHead title="Groups" action={<button className="link" onClick={() => go('/new')}>New group</button>} />
      <ol className="slips">
        {rows.map(({ g, net }, i) => {
          const gt = theme(g.theme).c
          return (
            <li key={g.id}>
              <button className="slip" onClick={() => go('/g/' + g.id)}>
                <span className="slip-kind" style={{ background: gt.accent, color: gt.onAccent }}><Icon n={g.kind} /></span>
                <span className="slip-body">
                  <span className="serial">No. {String(i + 1).padStart(2, '0')}</span>
                  <strong>{g.name}</strong>
                  <small>{g.members.length} people · {g.expenses.filter(e => !e.settle).length} expenses</small>
                </span>
                <span className="slip-amt">{net ? <Money p={net} /> : <span className="money settled-ink"><Icon n="check" size={20} /></span>}<small>{g.track ? 'tracking' : verbShort(g, net)}</small></span>
              </button>
            </li>
          )
        })}
      </ol>
      <SectionHead title="Recent" />
      <ol className="ledger">
        {recent.map(({ g, e, i }) => <LedgerRow key={e.id} g={g} e={e} serial={i + 1} showGroup />)}
      </ol>
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
  const list = g.expenses.map((e, i) => ({ e, i })).sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
  const remindAll = `Tiny reminder from ${g.name}:\n` + toMe.map(d => `${realName(s, g, d.from)}: ${inr(d.amount)} → ${shareLink(s, g, d)}`).join('\n')
  return (
    <Screen t={t} back title={g.name} fab={`/g/${g.id}/add`}
      action={<button className="iconbtn" aria-label="Group settings" onClick={() => go(`/g/${g.id}/edit`)}><Icon n="settings" /></button>}>
      <Denomination t={t} amount={net} line={g.track ? 'Tracking only, no nudges' : verb(g, net)}
        caption={<>{inr(total)} spent · your share {inr(share)} · you paid {inr(paid)}</>} />
      {spent.length > 0 && !debts.length && <Seal t={t} />}
      <SpendBar g={g} />
      {debts.length > 0 && <>
        <SectionHead title={g.track ? 'Balances' : 'Who hasn’t paid'}
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
              {!g.track && (
                <span className="debt-actions">
                  <button className="btn-sm" onClick={() => go(`/g/${g.id}/pay/${d.from}/${d.to}/${d.amount}`)}>Settle</button>
                  {d.to === ME && <a className="btn-sm ghost" href={wa(reminder(s, g, d))} target="_blank" rel="noopener"><Icon n="bell" size={16} />Remind</a>}
                </span>
              )}
            </li>
          ))}
        </ol>
      </>}
      <SectionHead title="Ledger" />
      {list.length ? <ol className="ledger">{list.map(({ e, i }) => <LedgerRow key={e.id} g={g} e={e} serial={i + 1} />)}</ol>
        : <p className="empty">Nothing here yet. Add the first expense with the + button.</p>}
    </Screen>
  )
}

export function Settle({ s, g, from, to, amount, t = g.theme, onRecord }: {
  s: State; g: Group; from: Id; to: Id; amount: number; t?: ThemeId; onRecord?: (paise: number, vpa: string) => void
}) {
  const payee = realName(s, g, to)
  const vpa = upiOf(s, g, to)
  const [qr, setQr] = useState('')
  const [asked, setAsked] = useState(false)
  const note = `${g.name} settlement`
  const link = isVpa(vpa) ? upiLink(vpa, payee, amount, note) : ''
  useEffect(() => {
    if (link) QRCode.toDataURL(link, { margin: 1, width: 480, color: { dark: '#000000', light: '#ffffff' } }).then(setQr)
  }, [link])
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
