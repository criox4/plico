import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import QRCode from 'qrcode'
import { ME, balances, missedChecks, personKey, pairwise, showUtr, simplify, toCheck, today, verifyLabel, type Expense, inr, upiLink, isVpa, encodeShare, type Group, type Id, type Kind, type Transfer } from './logic'
import { update, useStore, type State } from './store'
import { THEMES, ensureFonts, theme, themeVars, type ThemeId } from './themes'
import { Icon, type IconName } from './icons'
import { IssuesBanner } from './history'
import { friendBalance, friendPath, friendsOf } from './people'
import { API } from './auth-client'
import { addProof, api, fileUrl, photoData, pull, useSync } from './sync'
import { enablePush, mayAsk, notNow, pushState, type PushState } from './push'
import { ChatButton } from './chat'
import { AnimatePresence } from 'motion/react'
import { flushSync } from 'react-dom'
import { Capacitor } from '@capacitor/core'
import { Haptics, NotificationType } from '@capacitor/haptics'
import * as m from 'motion/react-m'
import { FADE, ROW, SPRING } from './anim'

/** The selected option's background in a .seg control. One per control id, so Motion slides it between options. */
export const SegPill = ({ id }: { id: string }) => <m.span layoutId={`seg-${id}`} className="seg-pill" transition={SPRING} aria-hidden />

// ---------- routing ----------
export function useRoute() {
  const [h, setH] = useState(location.hash)
  useEffect(() => {
    let last = location.hash
    const f = () => {
      const next = location.hash, show = () => { flushSync(() => setH(next)); scrollTo(0, 0) }
      // Going deeper slides in from the right, coming back from the left (styles.css, view transitions). Browsers
      // without view transitions, and reduce motion, just switch.
      const [a, b] = [TABS.indexOf(tab(last)), TABS.indexOf(tab(next))]
      document.documentElement.dataset.nav = (a >= 0 && b >= 0 ? b < a : depth(next) < depth(last)) ? 'back' : 'fwd'
      last = next
      if (document.startViewTransition && !calm()) document.startViewTransition(show)
      else show()
    }
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  return h.replace(/^#\/?/, '').split('/').filter(Boolean)
}
/** The dock's tabs in order, so moving between them slides the way the dock reads. */
const TABS = ['', 'friends', 'activity', 'me']
const tab = (h: string) => { const p = h.replace(/^#\/?/, '').split('/').filter(Boolean); return p.length > 1 ? '-' : p[0] ?? '' } // '-': not a tab
const depth = (h: string) => h.replace(/^#\/?/, '').split('/').filter(Boolean).length
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
  direct: { label: 'Friend', theme: 'classic', hint: '' }, // two friends, no group: made from the Friends tab
}
/** The kinds you can pick when making a group. */
export const GROUP_KINDS = (Object.keys(KINDS) as Kind[]).filter(k => k !== 'direct')
export const PUBLIC = import.meta.env.VITE_PUBLIC_URL || location.origin
/** A group's display name: a friends (direct) group is called by the other person's name. */
export const groupTitle = (g: Group) => (g.kind === 'direct' ? g.members.find(m => m.id !== ME)?.name ?? 'Friend' : g.name)
export const who = (g: Group, id: Id) => (id === ME ? 'You' : g.members.find(m => m.id === id)?.name ?? 'Someone')
export const realName = (s: State, g: Group, id: Id) => (id === ME ? s.me.name || 'Me' : who(g, id))
export const upiOf = (s: State, g: Group, id: Id) => (id === ME ? s.me.upi : g.members.find(m => m.id === id)?.upi) ?? ''
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
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
  shameless: (a: string, to: string, g: string) => `${g} khatam, hisaab abhi baaki hai 😄 ${a} → ${to}`,
}
export const shareLink = (s: State, g: Group, t: Transfer) =>
  `${PUBLIC}/#/s/${encodeShare({ g: groupTitle(g), f: realName(s, g, t.from), t: realName(s, g, t.to), v: upiOf(s, g, t.to) || undefined, a: t.amount })}`
export const reminder = (s: State, g: Group, t: Transfer) =>
  `${TONES[s.tone](inr(t.amount), realName(s, g, t.to), groupTitle(g))}\nPay here: ${shareLink(s, g, t)}`
/** A WhatsApp message to share; with a phone (+<country><number>), straight to that person's chat. */
export const wa = (text: string, phone?: string) => `https://wa.me/${phone?.replace(/\D/g, '') ?? ''}?text=` + encodeURIComponent(text)

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

export const EMOJI = ['🌵', '🦊', '🌙', '🍜', '🎧', '🐯', '🌸', '☕', '🏏', '🎸', '🥭', '🍕', '🐼', '🌊', '⚡', '🪁', '🏖️', '🏔️', '🏠', '🎉', '⚽', '🍻', '🚗', '💼']

/** A private group photo (receipt, cover) as a local URL; '' while loading or when there's none. */
export function useGroupImage(gid: Id, name?: string) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setUrl(''); setFailed(false)
    if (!name) return
    let live = true, made = ''
    fileUrl(`/api/groups/${gid}/files/${name}`).then(u => { made = u; if (live) setUrl(u) }).catch(() => live && setFailed(true))
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [gid, name])
  return { url, failed }
}

// ---------- people ----------
export const initials = (n: string) => n.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase()).join('') || '?'
/** A Plico face from a 6-hex seed: its own stem, bowl and backdrop colours. */
export const plicoColors = (seed: string) => {
  const h = parseInt(seed, 16) % 360
  return { '--brand': `hsl(${h} 62% 52%)`, '--plico-bowl': `hsl(${(h + 48) % 360} 80% 78%)`, background: `hsl(${h} 70% 94%)` }
}
export const randomSeed = () => Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')

/** Profile picture: an uploaded photo, a Google photo, an emoji, a Plico face, or initials. */
export function Avatar({ name, image, size = 56 }: { name: string; image?: string | null; size?: number }) {
  const box = { width: size, height: size }
  if (image?.startsWith('emoji:')) return <span className="avatar avatar-emoji" style={{ ...box, fontSize: size * 0.56 }} aria-hidden>{image.slice(6)}</span>
  if (image?.startsWith('plico:')) return <span className="avatar avatar-plico" style={{ ...box, ...plicoColors(image.slice(6)) } as CSSProperties} aria-hidden><Plico size={size * 0.78} /></span>
  if (image) return <img className="avatar" src={image.startsWith('/') ? API + image : image} alt="" width={size} height={size} referrerPolicy="no-referrer" />
  return <span className="avatar" style={{ ...box, fontSize: size * 0.38 }} aria-hidden>{initials(name)}</span>
}

// ---------- primitives ----------
export function Money({ p, sign, className = '' }: { p: number; sign?: boolean; className?: string }) {
  return <span className={`money ${tone(p)} ${className}`}>{sign && p > 0 ? '+' : sign && p < 0 ? '−' : ''}{inr(p)}</span>
}

export function Screen({ t, title, back, action, fab, preview, children }: {
  t: ThemeId; title?: ReactNode; back?: boolean | (() => void); action?: ReactNode; fab?: string
  /** Render signed in with this sample state (the share-card page), whoever is looking. */
  preview?: State; children: ReactNode
}) {
  const live = useStore()
  const s = preview ?? live
  const sync = useSync()
  const here = preview ? [''] : location.hash.replace(/^#\/?/, '').split('/')
  // The app's navigation, for anyone signed in and past the age question: a sidebar on wide screens,
  // bottom tabs on phones (only on the top-level screens, which pass `fab`).
  const shell = !!preview || (sync.authed && !!s.user?.ageGroup && s.user.onboarded !== false)
  return (
    <div className={`screen${shell ? ' has-nav' : ''}`} data-theme={t} style={themeVars(t)}>
      {shell && <Sidebar s={s} add={fab ?? '/add'} unread={sync.unread} here={here} />}
      {!shell && (
        // Signed out or not set up yet: on wide screens the brand holds the left half, the form stays a comfortable width.
        <aside className="brand-pane" aria-hidden>
          <Ornament t="classic" />
          <Wordmark />
          <div>
            <Plico mood="settled" size={88} />
            <p className="brand-pane-line">Hisaab sorted.</p>
            <p className="brand-pane-sub">Split trips, rent and dinners. Settle up over UPI.</p>
          </div>
        </aside>
      )}
      <header className="bar">
        {back ? <button className="iconbtn" onClick={typeof back === 'function' ? back : goBack} aria-label="Back"><Icon n="back" /></button>
          : !title && <span className="bar-brand"><Wordmark /></span>}
        {title && <h1 className="bar-title">{title}</h1>}
        <span className="bar-end">
          {shell && here[0] !== 'search' && <button className="iconbtn" aria-label="Search" aria-keyshortcuts="/" onClick={() => go('/search')}><Icon n="search" /></button>}
          {action}
        </span>
      </header>
      <main className="main">{children}</main>
      {shell && fab && sync.ai && s.user?.ai && <ChatButton />}
      {shell && fab && (
        <nav className="dock" aria-label="Main">
          <Tab to="/" icon="home" label="Home" on={!here[0]} />
          <Tab to="/friends" icon="direct" label="Friends" on={here[0] === 'friends' || here[0] === 'f'} />
          <button className="fab" onClick={() => go(fab)} aria-label="Add expense"><Icon n="plus" size={28} /></button>
          <Tab to="/activity" icon="log" label="Activity" on={here[0] === 'activity'} badge={sync.unread} />
          <Tab to="/me" icon="user" label="You" on={here[0] === 'me'} />
        </nav>
      )}
    </div>
  )
}

const Badge = ({ n }: { n: number }) => (n ? <span className="badge" aria-label={`${n} new`}>{n > 99 ? '99+' : n}</span> : null)
function Tab({ to, icon, label, on, badge = 0 }: { to: string; icon: IconName; label: string; on: boolean; badge?: number }) {
  return <a className={`dock-item${on ? ' on' : ''}`} href={'#' + to} aria-current={on ? 'page' : undefined}><span className="dock-icon"><Icon n={icon} /><Badge n={badge} />{on && <m.span layoutId="dock-dot" className="dock-dot" transition={SPRING} />}</span>{label}</a>
}

/** Wide screens: the app's own theme (not the group's), so navigation stays put as you move between groups. */
function Sidebar({ s, add, unread, here }: { s: State; add: string; unread: number; here: string[] }) {
  const groups = s.groups.filter(g => g.kind !== 'direct')
  const item = (to: string, icon: IconName, label: string, on: boolean, badge = 0) => (
    <a href={'#' + to} className={`side-item${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}><Icon n={icon} /><span>{label}</span><Badge n={badge} />{on && <m.span layoutId="side-pill" className="side-pill" transition={SPRING} />}</a>
  )
  return (
    <nav className="side" aria-label="Main" data-theme={s.theme} style={themeVars(s.theme)}>
      <a href="#/" className="side-brand" aria-label="Plico home"><Wordmark /></a>
      <button className="btn primary side-add" onClick={() => go(add)}><Icon n="plus" />Add expense</button>
      {item('/', 'home', 'Home', !here[0])}
      {item('/friends', 'direct', 'Friends', here[0] === 'friends' || here[0] === 'f')}
      {item('/activity', 'log', 'Activity', here[0] === 'activity', unread)}
      <p className="side-head"><span>Groups</span><a href="#/new" className="link">New</a></p>
      <ul className="side-groups">
        {groups.map(g => {
          const n = balances(g)[ME] ?? 0, gt = theme(g.theme)
          return (
            <li key={g.id}><a href={`#/g/${g.id}`} className={`side-group${here[0] === 'g' && here[1] === g.id ? ' on' : ''}`} aria-current={here[0] === 'g' && here[1] === g.id ? 'page' : undefined}>
              <span className="side-tile" style={{ background: gt.c.accent, color: gt.c.onAccent }}>{g.emoji ? <span>{g.emoji}</span> : <Icon n={g.kind} size={16} />}</span>
              <span className="side-name">{g.name}</span>
              {n !== 0 && !g.track && <span className={`money ${tone(n)}`}>{inr(Math.round(n / 100) * 100)}</span>}
            </a></li>
          )
        })}
      </ul>
      <a href="#/me" className={`side-me${here[0] === 'me' ? ' on' : ''}`} aria-current={here[0] === 'me' ? 'page' : undefined}>
        <Avatar name={s.me.name} image={s.user?.image} size={36} />
        <span><strong>{s.me.name || 'You'}</strong><small>{s.user?.email}</small></span>
      </a>
    </nav>
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
  // Rupees lead; paise ride small beside them, so the size reads at a glance without losing the exact amount.
  const [rupees, paise] = inr(shown).replace('₹', '').split('.')
  // Size to the final value so the numeral doesn't resize while it counts.
  const [finalRupees, finalPaise] = inr(amount).replace('₹', '').split('.')
  const chars = finalRupees.length + (finalPaise ? 1.1 : 0)
  return (
    <section className="hero" aria-label={`${line}: ${inr(amount)}`}>
      <Ornament t={t} />
      <p className={`hero-num ${tone(amount)}`} aria-hidden style={{ '--chars': chars } as CSSProperties}><span className="cur">₹</span>{rupees}{paise && <span className="paise">.{paise}</span>}</p>
      <p className="hero-verb" aria-hidden>{line}</p>
      {caption && <p className="hero-cap">{caption}</p>}
    </section>
  )
}

const Peaceful = () => (
  <div className="peaceful"><Plico mood="empty" size={64} /><p><strong>Suspiciously peaceful in here.</strong>Add the first expense with +.</p></div>
)

/** After adding an expense: everyone in it converges around their share for a beat. */
export function Converge({ s, g, e }: { s: State; g: Group; e: Expense }) {
  const ids = Object.keys(e.owed)
  const vals = Object.values(e.owed)
  const line = ids.length < 2 ? `${inr(e.amount)} added` : vals.every(v => v === vals[0]) ? `${inr(vals[0])} each` : `${inr(e.amount)}, ${ids.length} ways`
  return (
    <div className="converge" data-theme={s.theme} style={themeVars(s.theme)} role="status" aria-label={`Added ${e.title}: ${line}`}>
      <div className="cv-ring" aria-hidden>
        {ids.slice(0, 8).map((id, i, a) => {
          const ang = (i / a.length) * 2 * Math.PI - Math.PI / 2
          return (
            <span key={id} className="cv-av" style={{ '--tx': `${Math.round(Math.cos(ang) * 104)}px`, '--ty': `${Math.round(Math.sin(ang) * 104)}px`, '--i': i } as CSSProperties}>
              <Avatar name={realName(s, g, id)} image={id === ME ? s.user?.image : g.members.find(m => m.id === id)?.image} size={48} />
            </span>
          )
        })}
        <p className="cv-num">{line}</p>
      </div>
      <p className="cv-title">{e.title} · {groupTitle(g)}</p>
    </div>
  )
}

export const SectionHead = ({ title, action, id }: { title: string; action?: ReactNode; id?: string }) => (
  <div className="section-head"><h2 id={id}>{title}</h2>{action}</div>
)

const CONFETTI = ['#6C5CE7', '#22B983', '#EA6673', '#F4A340', '#B7AEF5']
const SHAPES = ['strip', 'square', 'dot']
/** Paper confetti bursting from behind the seal the moment a group becomes even. Each piece is three nested elements so
 *  drift, rise-and-fall and tumble can each have their own easing (that's what reads as gravity). Pieces vary in size,
 *  shape, speed and spin from a fixed hash, so it looks random but never flickers between renders. CSS skips it with
 *  reduced motion. */
const hash = (i: number, k: number) => { const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x) }
const Confetti = () => (
  <div className="confetti" aria-hidden>
    {Array.from({ length: 28 }, (_, i) => {
      const a = (i / 28) * Math.PI * 2 + hash(i, 1) * 0.5, power = 70 + hash(i, 2) * 90
      return (
        <i key={i} style={{ '--x': `${Math.round(Math.cos(a) * power * 1.3)}px`, '--t': `${1600 + Math.round(hash(i, 3) * 800)}ms`, '--d': `${Math.round(hash(i, 4) * 90)}ms` } as CSSProperties}>
          <b style={{ '--up': `${Math.round(-60 - Math.max(0, -Math.sin(a)) * power - hash(i, 5) * 50)}px`, '--fall': `${Math.round(160 + hash(i, 6) * 120)}px` } as CSSProperties}>
            <em className={SHAPES[i % 3]} style={{ '--c': CONFETTI[i % 5], '--s': `${0.7 + hash(i, 7) * 0.6}`, '--spin': `${500 + Math.round(hash(i, 8) * 700)}ms`, '--r': `${Math.round(hash(i, 9) * 360)}deg`, '--ax': `${(hash(i, 10) * 2 - 1).toFixed(2)}` } as CSSProperties} />
          </b>
        </i>
      )
    })}
  </div>
)

// Groups whose open debts we saw this session, so the moment they reach zero can be celebrated once.
const hadDebts = new Map<Id, boolean>()
function useJustSettled(gid: Id, open: number) {
  const [burst, setBurst] = useState(false)
  useEffect(() => {
    if (hadDebts.get(gid) && !open) setBurst(true)
    hadDebts.set(gid, open > 0)
  }, [gid, open])
  return burst
}

export function Seal({ t, replay = 0, caption = 'Hisaab clear ✨', burst }: { t: ThemeId; replay?: number; caption?: string; burst?: boolean }) {
  const id = useId()
  // On phones, a success tap as the seal lands and the confetti bursts (web has no reliable equivalent).
  useEffect(() => {
    if (!burst || !Capacitor.isNativePlatform()) return
    const t = setTimeout(() => void Haptics.notification({ type: NotificationType.Success }).catch(() => {}), 350)
    return () => clearTimeout(t)
  }, [burst, replay])
  const th = theme(t)
  const ring = `${th.celebrate} · plico · ${th.celebrate} · plico · `.toUpperCase()
  return (
    <div className="seal" key={replay} role="status">
      {burst && <Confetti />}
      <svg className="seal-svg" viewBox="-60 -60 120 120" aria-hidden>
        <defs><path id={id} d="M-44 0a44 44 0 1 1 88 0a44 44 0 1 1-88 0" /></defs>
        {(th.ornament === 'ripple' || t === 'midnight') && <g className="seal-ripples">{[20, 20, 20].map((r, i) => <circle key={i} r={r} style={{ animationDelay: `${i * 180}ms` }} />)}</g>}
        {/* pathLength 1: the rings draw themselves in with a single dash, whatever their shape */}
        {th.radius === 0 ? <><rect className="seal-pulse" x="-54" y="-54" width="108" height="108" /><rect className="seal-outer" pathLength={1} x="-54" y="-54" width="108" height="108" /><rect className="seal-inner" pathLength={1} x="-34" y="-34" width="68" height="68" /></>
          : <><circle className="seal-pulse" r="56" /><circle className="seal-outer" pathLength={1} r="56" /><circle className="seal-inner" pathLength={1} r="36" /></>}
        <text className="seal-text"><textPath href={`#${id}`} textLength="272">{ring}</textPath></text>
        <g className="seal-plico" transform="translate(-17 -17) scale(1.05)"><g className="pl-bowl">{BOWL}<circle className="pl-eye" cx="17.6" cy="12.4" r="1.7" /><circle className="pl-eye" cx="23.2" cy="12.4" r="1.7" /><path className="pl-smile" d="M18.4 16.4q2 1.8 4 0" /></g>{STEM}</g>
        {t === 'chai' && <g className="seal-steam">{[-10, 0, 10].map(x => <path key={x} d={`M${x} -62c-5 -6 5 -10 0 -16s5 -10 0 -16`} />)}</g>}
      </svg>
      <p className="seal-caption"><span className="seal-word"><span>{/[.!?]$/.test(th.celebrate) ? th.celebrate : th.celebrate + "."}</span></span> <span className="seal-rest">{caption}</span></p>
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
    <m.li className="ledger-row" {...ROW}>
      <button onClick={() => go(`/g/${g.id}/e/${e.id}`)}>
        <span className={`cat ${e.settle && !e.rejected ? 'cat-settled' : ''}`}><Icon n={e.settle ? 'check' : (e.cat as IconName)} /></span>
        <span className="lr-body">
          <strong>{e.settle ? `${by} paid ${lower(who(g, Object.keys(e.owed)[0]))}` : e.title}</strong>
          <small><span className="serial">{no} · </span>{e.rejected ? 'not received' : e.settle ? ['settlement', verifyLabel(e)].filter(Boolean).join(' · ') : `${inr(e.amount)}, ${lower(by)} paid`}{showGroup ? ` · ${groupTitle(g)}` : ''}</small>
        </span>
        {e.settle ? <span className="lr-amt"><span className={`money ${e.rejected ? 'muted-ink' : 'settled-ink'}`}>{inr(e.amount)}</span></span>
          : <span className="lr-amt"><Money p={mine} sign /><small>{mine > 0 ? 'you lent' : mine < 0 ? 'your share' : 'not in it'}</small></span>}
      </button>
    </m.li>
  )
}

// ---------- settlements: they count when recorded; the payee says whether it arrived ----------
const ends = (e: Expense) => ({ from: Object.keys(e.paid)[0], to: Object.keys(e.owed)[0] })
const setPending = (gid: Id, eid: Id, ok: boolean) => update(d => {
  const g = d.groups.find(x => x.id === gid)
  if (!g) return
  const e = g.expenses.find(x => x.id === eid)
  if (!e) return
  delete e.pending
  if (ok) e.verifiedBy = 'payee' // the server sets it too; this shows it before the next pull
  else e.rejected = true // tells the payer; they dismiss or pay again
})
const drop = (gid: Id, eid: Id) => update(d => {
  const g = d.groups.find(x => x.id === gid)
  if (g) g.expenses = g.expenses.filter(x => x.id !== eid)
})

/** The payer's side after "Not yet": nothing moved; pay again or clear it. */
export function NotReceivedCard({ g, e, showGroup }: { g: Group; e: Expense; showGroup?: boolean }) {
  const { to } = ends(e)
  return (
    <m.li className="confirm-card warn" {...ROW}>
      <p><strong>{who(g, to)} hasn’t got your <span className="money">{inr(e.amount)}</span> yet</strong>
        <small>{showGroup ? `${groupTitle(g)} · ` : ''}Check your UPI app. If it went through, send them the transaction ID.</small></p>
      <span className="debt-actions">
        <button className="btn-sm" onClick={() => { drop(g.id, e.id); go(`/g/${g.id}/pay/${ME}/${to}/${e.amount}`) }}>Pay again</button>
        <button className="btn-sm ghost" onClick={() => drop(g.id, e.id)}>Dismiss</button>
      </span>
    </m.li>
  )
}

/** The payee's side: someone says they paid you. It already counts; you're the only one who can say it arrived. */
export function ConfirmCard({ g, e, showGroup }: { g: Group; e: Expense; showGroup?: boolean }) {
  const { from } = ends(e)
  return (
    <m.li className="confirm-card" {...ROW}>
      <p><strong>{who(g, from)} marked <span className="money">{inr(e.amount)}</span> as paid to you</strong>
        <small>{showGroup ? `${groupTitle(g)} · ` : ''}It already counts. Check your UPI app, then say if it arrived.</small></p>
      <span className="debt-actions">
        <button className="btn-sm" onClick={() => setPending(g.id, e.id, true)}><Icon n="check" size={16} />Got it</button>
        <button className="btn-sm ghost" onClick={() => setPending(g.id, e.id, false)}>Not received</button>
      </span>
    </m.li>
  )
}
const waitingFor = (g: Group) => g.expenses.filter(toCheck)
const bounced = (g: Group) => g.expenses.filter(e => e.rejected && ends(e).from === ME)
/** Settlements that need you: say whether money arrived, or deal with money that didn't. */
function NeedsYou({ groups, showGroup }: { groups: Group[]; showGroup?: boolean }) {
  const items = groups.flatMap(g => [...waitingFor(g).map(e => <ConfirmCard key={e.id} g={g} e={e} showGroup={showGroup} />),
    ...bounced(g).map(e => <NotReceivedCard key={e.id} g={g} e={e} showGroup={showGroup} />)])
  return (
    <AnimatePresence initial={false}>
      {items.length > 0 && <m.div key="needs" {...FADE}><SectionHead title="Needs you" /><ol className="debts"><AnimatePresence initial={false}>{items}</AnimatePresence></ol></m.div>}
    </AnimatePresence>
  )
}

/** The dashboard: where your money stands, what needs you, and every group and person at a glance.
 *  Computed on the phone from the synced ledger, so it works offline. Phones stack it; wide screens add a right rail. */
export function Home({ s, t, banner, preview }: { s: State; t: ThemeId; banner?: ReactNode; preview?: boolean }) {
  const all = s.groups.map(g => ({ g, net: balances(g)[ME] ?? 0 }))
  const rows = all.filter(r => r.g.kind !== 'direct') // friends' balances count in the total, but aren't groups
  const live = all.filter(r => !r.g.track)
  const total = live.reduce((a, r) => a + r.net, 0)
  // Net per person across groups, like Needs you and People: owing Bala in one group and being owed more in another is
  // nothing to pay. Collect is derived so the tiles always add up to the total.
  const each = new Map<string, number>()
  for (const { g } of live) for (const m of g.members) if (m.id !== ME) {
    const k = personKey(m) ?? `${g.id}:${m.id}`
    each.set(k, (each.get(k) ?? 0) + pairwise(g, ME, m.id))
  }
  const pay = [...each.values()].reduce((a, n) => a + Math.max(-n, 0), 0)
  const collect = total + pay
  const open = rows.filter(r => r.net && !r.g.track).length
  const people = friendsOf(s)
    .map(f => ({ f, n: friendBalance(f) })).sort((a, b) => Math.abs(b.n) - Math.abs(a.n) || a.f.name.localeCompare(b.f.name)).slice(0, 6)
  const recent = s.groups
    .flatMap(g => g.expenses.map((e, i) => ({ g, e, i })))
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
    .slice(0, 6)
  const fresh = !rows.length
  return (
    <Screen t={t} preview={preview ? s : undefined} fab={s.groups.length ? '/add' : '/new'} action={<button className="iconbtn hide-wide" aria-label="You and settings" onClick={() => go('/me')}><Avatar name={s.me.name} image={s.user?.image} size={32} /></button>}>
      <div className="dash">
        <div className="dash-main">
          <div className="d-hero">
            {fresh && !total ? <h1 className="q d-welcome">Welcome{s.me.name ? `, ${s.me.name.split(' ')[0]}` : ''}.</h1>
              : <Denomination t={t} amount={total} line={verb(null, total, true)} />}
            {!fresh && <ul className="d-stats" aria-label="Summary">
              <li aria-label={`To collect ${inr(collect)}`}><small>To collect</small><span className={`money ${collect ? 'pos' : ''}`}>{inr(rupees(collect))}</span></li>
              <li aria-label={`To pay ${inr(pay)}`}><small>To pay</small><span className={`money ${pay ? 'neg' : ''}`}>{inr(rupees(pay))}</span></li>
              <li><small>Open groups</small><span className="money">{open}<i> of {rows.length}</i></span></li>
            </ul>}
          </div>
          <nav className="d-actions" aria-label="Quick actions">
            <button onClick={() => go(s.groups.length ? '/add' : '/new')}><Icon n="plus" />Add expense</button>
            <button onClick={() => go('/new')}><Icon n="friends" />New group</button>
            <button onClick={() => go('/friends/add')}><Icon n="direct" />Add friend</button>
            <button onClick={() => go('/import')}><Icon n="arrow" />Import</button>
          </nav>
          {banner && <div className="d-banner">{banner}</div>}
          {fresh && (
            <section className="d-card d-start" aria-labelledby="d-start">
              <div className="hello"><Plico mood="idle" size={56} /><p><strong id="d-start">Start your first group.</strong>Pick who’s spending together. You can invite them by email next.</p></div>
              <div className="kinds">
                {GROUP_KINDS.map(k => <button key={k} className="kind" onClick={() => go('/new/' + k)}><Icon n={k} size={26} /><span>{KINDS[k].label}</span></button>)}
              </div>
            </section>
          )}
          <ThisMonth groups={s.groups} />
          {!fresh && <section className="d-groups" aria-labelledby="d-groups">
            <SectionHead title="Groups" id="d-groups" action={<button className="link" onClick={() => go('/new')}>New group</button>} />
            <ol className="slips">
              {rows.map(({ g, net }, i) => {
                const gt = theme(g.theme)
                const last = g.expenses.reduce((a, e) => (e.date > a ? e.date : a), '')
                return (
                  <li key={g.id} style={{ '--i': i, '--gnum': `${gt.num}, ${gt.ui}, system-ui` } as CSSProperties}>
                    <button className="slip" onClick={() => go('/g/' + g.id)}>
                      <span className="slip-kind" style={{ background: gt.c.accent, color: gt.c.onAccent }}>{g.emoji ? <span className="slip-emoji">{g.emoji}</span> : <Icon n={g.kind} />}</span>
                      <span className="slip-body">
                        <span className="serial">No. {String(i + 1).padStart(2, '0')}</span>
                        <strong>{g.name}</strong>
                        <small>{count(g.members.length, 'person', 'people')}{last ? ` · ${ago(last)}` : ' · no expenses yet'}</small>
                      </span>
                      <span className="slip-amt">{net ? <Money p={net} /> : <span className="money settled-ink"><Icon n="check" size={20} /></span>}<small>{g.track ? 'tracking' : verbShort(g, net)}</small></span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </section>}
        </div>

        <aside className="dash-rail" aria-label="People and activity">
          {(!fresh || s.groups.length > 0) && <DashNeeds s={s} />}
          {people.length > 0 && <section className="d-people" aria-labelledby="d-people">
            <SectionHead title="People" id="d-people" action={<button className="link" onClick={() => go('/friends')}>All friends</button>} />
            <ol className="d-list">
              {people.map(({ f, n }) => (
                <li key={f.key}><button className="d-row" onClick={() => go(friendPath(f))}>
                  <Avatar name={f.name} image={f.image} size={36} />
                  <span className="grow"><strong>{f.name}</strong><small>{n > 0 ? 'owes you' : n < 0 ? 'you owe' : 'settled up'}</small></span>
                  {n ? <span className={`money ${tone(n)}`}>{inr(Math.abs(n))}</span> : <Icon n="check" size={18} />}
                </button></li>
              ))}
            </ol>
          </section>}
          {!fresh && <section className="d-recent" aria-labelledby="d-recent">
            <SectionHead title="Latest" id="d-recent" action={recent.length > 0 && <button className="link" onClick={() => go('/activity')}>All activity</button>} />
            {recent.length ? <ol className="ledger"><AnimatePresence initial={false}>{recent.map(({ g, e, i }) => <LedgerRow key={e.id} g={g} e={e} serial={i + 1} showGroup />)}</AnimatePresence></ol> : <Peaceful />}
          </section>}
        </aside>
      </div>
    </Screen>
  )
}

/** Whole rupees for at-a-glance tiles; the exact amount lives in the label. */
const rupees = (p: number) => Math.round(p / 100) * 100

/** "today", "yesterday", "3 days ago", or the date. */
function ago(day: string) {
  const d = Math.round((Date.parse(today()) - Date.parse(day)) / 864e5)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 7 ? `${d} days ago` : new Date(day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

const monthOf = (back: number) => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back)
  return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, name: d.toLocaleString('en-IN', { month: 'long' }) }
}
/** Top four categories, the rest folded into Other, so the bar adds up to the total above it. */
const byCat = (es: Expense[], val: (e: Expense) => number) => {
  const all = Object.entries(es.reduce<Record<string, number>>((m, e) => ((m[e.cat] = (m[e.cat] ?? 0) + val(e)), m), {})).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  if (all.length <= 5) return all
  const top = all.slice(0, 4).filter(([c]) => c !== 'other')
  return [...top, ['other', all.filter(x => !top.includes(x)).reduce((a, [, v]) => a + v, 0)] as [string, number]]
}

/** Your share of spending this month, by category, against last month. */
function ThisMonth({ groups }: { groups: Group[] }) {
  const [now, prev] = [monthOf(0), monthOf(1)]
  const mine = (key: string) => groups.flatMap(g => g.expenses).filter(e => !e.settle && e.date.startsWith(key) && e.owed[ME])
  const cur = mine(now.key), old = mine(prev.key)
  const sum = (es: Expense[]) => es.reduce((a, e) => a + (e.owed[ME] ?? 0), 0)
  const [a, b] = [sum(cur), sum(old)]
  if (!a && !b) return null
  const pct = b ? Math.round(((a - b) / b) * 100) : 0
  return (
    <section className="d-card d-month" aria-labelledby="d-month">
      <p className="d-month-head"><span><small id="d-month">Your share in {now.name}</small><span className="money d-month-num">{inr(a)}</span></span>
        <small className="d-delta">{!b ? `Nothing in ${prev.name} to compare` : pct === 0 ? `Same as ${prev.name}` : `${Math.abs(pct)}% ${pct > 0 ? 'more' : 'less'} than ${prev.name} (${inr(b)})`}</small></p>
      {a > 0 ? <SpendBar cats={byCat(cur, e => e.owed[ME] ?? 0)} /> : <small>No spending yet this month.</small>}
    </section>
  )
}

/** Money waiting on you: payments to check, payments that bounced, and who you owe, net across every group you share
 *  (if Bala owes you more elsewhere, you don't owe Bala). Tracking-only groups never ask for money. */
function DashNeeds({ s }: { s: State }) {
  const groups = s.groups
  const cards = groups.flatMap(g => [...waitingFor(g).map(e => <ConfirmCard key={e.id} g={g} e={e} showGroup />),
    ...bounced(g).map(e => <NotReceivedCard key={e.id} g={g} e={e} showGroup />)])
  const owe = friendsOf(s)
    .map(f => {
      const live = f.spots.filter(x => !x.g.track)
      const n = live.reduce((a, x) => a + pairwise(x.g, ME, x.id), 0)
      const where = live.filter(x => pairwise(x.g, ME, x.id) !== 0)
      return { f, n, where }
    })
    .filter(x => x.n < 0).sort((a, b) => a.n - b.n)
  return (
    <section className="d-needs" aria-labelledby="d-needs">
      <SectionHead title="Needs you" id="d-needs" />
      <AnimatePresence initial={false} mode="wait">
      {cards.length || owe.length ? <m.ol key="list" className="debts" {...FADE}><AnimatePresence initial={false}>
        {cards}
        {owe.map(({ f, n, where }) => (
          <m.li className="debt" key={f.key} {...ROW}>
            <span className="grow"><strong>You owe {f.name}</strong><small>{where.length > 1 ? `Net across ${count(where.length, 'group', 'groups')}` : where[0]?.g.kind === 'direct' ? 'Outside groups' : where[0] ? groupTitle(where[0].g) : ''}</small></span>
            <span className="money neg">{inr(-n)}</span>
            <span className="debt-actions"><button className="btn-sm" onClick={() => go(`${friendPath(f)}/settle`)}>Settle</button></span>
          </m.li>
        ))}
      </AnimatePresence></m.ol> : <m.p key="clear" className="d-clear" {...FADE}><Icon n="check" size={18} />Nothing needs you right now.</m.p>}
      </AnimatePresence>
    </section>
  )
}

function SpendBar({ cats }: { cats: [string, number][] }) {
  if (!cats.length) return null
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

/** A group's page wears the group's theme, unless you've turned group themes off; every other screen wears yours. */
export const pageTheme = (s: State, g: Group) => (s.groupThemes === false ? s.theme : g.theme)

export function GroupView({ s, g, t = pageTheme(s, g) }: { s: State; g: Group; t?: ThemeId }) {
  const bal = balances(g)
  const net = bal[ME] ?? 0
  const spent = g.expenses.filter(e => !e.settle)
  const total = spent.reduce((a, e) => a + e.amount, 0)
  const share = spent.reduce((a, e) => a + (e.owed[ME] ?? 0), 0)
  const paid = spent.reduce((a, e) => a + (e.paid[ME] ?? 0), 0)
  const debts = simplify(bal)
  const toMe = debts.filter(d => d.to === ME)
  const friends = friendsOf(s)
  const burst = useJustSettled(g.id, debts.length)
  const cover = useGroupImage(g.id, g.cover)
  const list = g.expenses.map((e, i) => ({ e, i })).sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
  const remindAll = `Tiny reminder from ${groupTitle(g)}:\n` + toMe.map(d => `${realName(s, g, d.from)}: ${inr(d.amount)} → ${shareLink(s, g, d)}`).join('\n')
  return (
    <Screen t={t} back title={groupTitle(g)} fab={`/g/${g.id}/add`}
      action={<button className="iconbtn" aria-label="Group settings" onClick={() => go(`/g/${g.id}/edit`)}><Icon n="settings" /></button>}>
      {/* Wide screens: the balance and expenses on the left, who still owes whom in a rail on the right. */}
      <div className="gv"><div className="gv-top">
      {g.cover && <div className="group-cover">{cover.url && <img src={cover.url} alt="" />}</div>}
      <Denomination t={t} amount={net} line={g.track ? 'Tracking only, no nudges' : verb(g, net)}
        caption={<>{inr(total)} spent · your share {inr(share)} · you paid {inr(paid)}</>} />
      {spent.length > 0 && !debts.length && <Seal t={t} burst={burst} />}
      <IssuesBanner gid={g.id} />
      <PushAsk g={g} />
      <NeedsYou groups={[g]} />
      <SpendBar cats={byCat(spent, e => e.amount)} />
      </div>
      <div className="gv-rail"><AnimatePresence initial={false}>
      {debts.length > 0 && <m.div key="debts" {...FADE}>
        <SectionHead title={g.track ? 'Balances' : 'Still to settle'}
          action={!g.track && toMe.length > 1 && <a className="link" href={wa(remindAll)} target="_blank" rel="noopener">Remind all</a>} />
        <ol className="debts"><AnimatePresence initial={false}>
          {debts.map(d => (
            <m.li className="debt" key={d.from + d.to} {...ROW}>
              <span className="debt-flow">
                <span className="who">{who(g, d.from)}</span>
                <span className="flow-arrow" role="img" aria-label="pays"><Icon n="arrow" size={18} /></span>
                <span className="who">{who(g, d.to)}</span>
              </span>
              <span className={`money ${d.to === ME ? 'pos' : d.from === ME ? 'neg' : ''}`}>{inr(d.amount)}</span>
              {!g.track && (
                <span className="debt-actions">
                  <button className="btn-sm" onClick={() => go(`/g/${g.id}/pay/${d.from}/${d.to}/${d.amount}`)}>Settle</button>
                  {d.to === ME && <RemindButton s={s} g={g} d={d} />}
                </span>
              )}
              {!g.track && d.from === ME && (() => {
                // They owe you more elsewhere: settle the net once instead of paying here.
                const f = friends.find(x => x.spots.some(y => y.g.id === g.id && y.id === d.to))
                const n = f ? friendBalance(f) : 0
                return f && n >= 0 && <small className="debt-wait">{f.name} {n > 0 ? `owes you ${inr(n)} overall` : 'and you are square overall'}, counting your other groups. <button className="link" onClick={() => go(`${friendPath(f)}${n > 0 ? '/settle' : ''}`)}>{n > 0 ? 'Settle the net' : 'See why'}</button></small>
              })()}
            </m.li>
          ))}
        </AnimatePresence></ol>
      </m.div>}
      </AnimatePresence></div>
      <div className="gv-list">
      <SectionHead title="Expenses" action={<button className="link" onClick={() => go(`/g/${g.id}/audit`)}>Audit log</button>} />
      {list.length ? <ol className="ledger"><AnimatePresence initial={false}>{list.map(({ e, i }) => <LedgerRow key={e.id} g={g} e={e} serial={i + 1} />)}</AnimatePresence></ol>
        : <Peaceful />}
      </div></div>
    </Screen>
  )
}

/** Remind in the app when they're on Plico (a push, rate-limited on the server); otherwise, or if that can't reach them, WhatsApp. */
function RemindButton({ s, g, d }: { s: State; g: Group; d: Transfer }) {
  const [st, setSt] = useState<'idle' | 'busy' | 'sent'>('idle')
  const [note, setNote] = useState('')
  const whatsapp = wa(reminder(s, g, d))
  if (!g.members.find(m => m.id === d.from)?.joined)
    return <a className="btn-sm ghost" href={whatsapp} target="_blank" rel="noopener"><Icon n="bell" size={16} />Remind</a>
  const send = async () => {
    setSt('busy'); setNote('')
    try { await api(`/api/groups/${g.id}/remind`, { method: 'POST', body: JSON.stringify({ memberId: d.from, amount: d.amount }) }); setSt('sent') }
    catch (e) { setSt('idle'); setNote(navigator.onLine ? (e as Error).message : 'Reminders need a connection.') }
  }
  return <>
    <button className="btn-sm ghost" disabled={st !== 'idle'} onClick={() => void send()}><Icon n={st === 'sent' ? 'check' : 'bell'} size={16} />{st === 'sent' ? 'Reminded' : 'Remind'}</button>
    {note && <small className="remind-note" role="status">{note} <a href={whatsapp} target="_blank" rel="noopener">Send on WhatsApp</a></small>}
  </>
}

/** Asks for notifications once the group gives a reason to (it exists; or you're waiting on a payment), at most once a fortnight. */
function PushAsk({ g }: { g: Group }) {
  const sync = useSync()
  const [state, setState] = useState<PushState | null>(null)
  const [hide, setHide] = useState(!mayAsk())
  useEffect(() => { if (!hide) void pushState(sync.push).then(setState, () => setState('unsupported')) }, [sync.push, hide])
  if (hide || state !== 'off') return null
  const mine = g.expenses.find(e => e.pending && ends(e).from === ME)
  return (
    <section className="confirm-card push-ask">
      <p><strong>{mine ? `Get told when ${who(g, ends(mine).to)} checks your payment?` : 'Get told when someone adds an expense or pays you?'}</strong>
        <small>Payments right away; everything else bundled, and never at night.</small></p>
      <span className="debt-actions">
        <button className="btn-sm" onClick={() => void enablePush(sync.push).catch(() => false).finally(() => setHide(true))}><Icon n="bell" size={16} />Turn on</button>
        <button className="btn-sm ghost" onClick={() => { notNow(); setHide(true) }}>Not now</button>
      </span>
    </section>
  )
}

export function Settle({ s, g, from, to, amount, t = s.theme, onRecord }: {
  s: State; g: Group; from: Id; to: Id; amount: number; t?: ThemeId
  /** Returns the settlement to offer proof for (yours, to someone who'll check it); otherwise it moves on by itself. */
  onRecord?: (paise: number, vpa: string) => { gid: Id; eid: Id } | void
}) {
  const payee = realName(s, g, to)
  const [backup, setBackup] = useState(false)
  const m = g.members.find(x => x.id === to)
  const alt = to === ME ? s.me.upi2 : m?.upi2
  const vpa = backup && alt ? alt : upiOf(s, g, to)
  const [asked, setAsked] = useState(false)
  const note = g.kind === 'direct' ? 'Plico settlement' : `${g.name} settlement`
  const link = isVpa(vpa) ? upiLink(vpa, payee, amount, note) : ''
  const qr = useQr(link)
  const [proof, setProof] = useState<{ gid: Id; eid: Id; method: Method } | null>(null)
  const record = (method: Method) => { const x = onRecord?.(amount, vpa); if (x) setProof({ ...x, method }) }
  return (
    <Screen t={t} back title="Settle up">
      <section className="pay" aria-label="Payment details">
        <p className="pay-who">{who(g, from) === 'You' ? 'You are paying' : `${who(g, from)} is paying`}</p>
        <p className="payee">{payee}</p>
        {vpa ? <code className="vpa">{vpa}</code> : <p className="pay-who">{to === ME ? 'Add your UPI ID in You › Profile so friends can pay you.'
          : m?.joined ? `${payee} hasn’t added a UPI ID yet. Ask them to add it in Plico, or pay another way.` : 'No UPI ID yet. Add theirs in group settings.'}</p>}
        {alt && isVpa(alt) && upiOf(s, g, to) && <button type="button" className="link" onClick={() => setBackup(!backup)}>{`${backup ? 'Use' : 'Not working? Use'} ${to === ME ? 'your' : 'their'} ${backup ? 'main' : 'backup'} UPI ID`}</button>}
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
            <button className="btn primary" onClick={() => record('upi')}>Yes, paid</button>
            <button className="btn secondary" onClick={() => setAsked(false)}>Not yet</button>
          </div>
        </div>
      ) : (
        <button className="link center-link" onClick={() => record('cash')}><Icon n="cash" size={18} />Paid in cash or another way</button>
      )}
      {proof && <ProofSheet gid={proof.gid} eid={proof.eid} payee={payee} method={proof.method} onClose={goBack} />}
    </Screen>
  )
}

// ---------- proof: settle first, verify after ----------
/** A small bottom sheet (centred on wide screens). Closes on the scrim, Escape, or its own buttons. */
export function Sheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const s = useStore()
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <m.div key="sheet" className="sheet-scrim" data-theme={s.theme} style={themeVars(s.theme)} onClick={e => { if (e.target === e.currentTarget) onClose() }} {...FADE}>
          <m.section className="sheet" role="dialog" aria-modal="true" aria-label={label} initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={SPRING}>{children}</m.section>
        </m.div>
      )}
    </AnimatePresence>
  )
}

type Method = 'upi' | 'cash' | 'bank'
const METHODS: Record<Method, string> = { upi: 'UPI', cash: 'Cash', bank: 'Bank transfer' }

/** After "I paid": optional proof. The payment is already recorded and counts; a receipt screenshot can verify it on the spot. */
export function ProofSheet({ gid, eid, payee, method: m0 = 'upi', onClose }: { gid: Id; eid: Id; payee: string; method?: Method; onClose: () => void }) {
  const [manual, setManual] = useState(false)
  const [method, setMethod] = useState<Method>(m0)
  const [utr, setUtr] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [done, setDone] = useState('')
  const offline = !navigator.onLine
  const send = async (body: () => Promise<Parameters<typeof addProof>[2]>) => {
    setBusy(true); setErr('')
    try {
      const r = await addProof(gid, eid, await body())
      const miss = missedChecks(r.proof)
      setDone(r.verifiedBy ? 'Verified from your receipt.' : miss ? `Couldn’t match it (${miss}). ${payee} will be asked to check.` : `Saved. ${payee} will be asked to check.`)
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Sheet open onClose={onClose} label="Add proof">
      <h2>{done ? 'Payment recorded' : 'Add proof (optional)'}</h2>
      {done ? <p role="status">{done}</p>
        : offline ? <p role="status">Your payment is saved and counts. You’re offline, so add proof later from the payment’s details.</p>
        : <>
          <p className="muted-p">Your payment already counts. Proof helps {payee} trust it at a glance.</p>
          {!manual ? <>
            <label className="btn primary" aria-busy={busy}>
              <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void send(async () => ({ method: 'upi', image: await photoData(f) })) }} />
              <Icon n="qr" />{busy ? 'Checking your receipt…' : 'Attach screenshot'}
            </label>
            <button className="btn secondary" disabled={busy} onClick={() => setManual(true)}>No screenshot</button>
          </> : (
            <form className="form" onSubmit={e => { e.preventDefault(); void send(async () => ({ method, utr: (method === 'upi' && utr) || undefined, note: note.trim() || undefined })) }}>
              <div className="seg" role="radiogroup" aria-label="How you paid">
                {(Object.keys(METHODS) as Method[]).map(k => <button type="button" key={k} role="radio" aria-checked={method === k} className={method === k ? 'on' : ''} onClick={() => setMethod(k)}>{method === k && <SegPill id="proof" />}{METHODS[k]}</button>)}
              </div>
              {method === 'upi' && <label className="field"><span>UPI transaction ID (optional)</span>
                <input inputMode="numeric" placeholder="12 digits" maxLength={12} value={utr} onChange={e => setUtr(e.target.value.replace(/\D/g, ''))} /></label>}
              <label className="field"><span>Note (optional)</span><input value={note} maxLength={120} onChange={e => setNote(e.target.value)} /></label>
              <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save proof'}</button>
            </form>
          )}
          {err && <p className="error" role="alert">{err}</p>}
        </>}
      <button className="link center-link" onClick={onClose}>{done || offline ? 'Done' : 'Skip'}</button>
    </Sheet>
  )
}

/** A settlement's details: the payer can add proof while it isn't verified. */
export function SettlementProof({ g, e }: { g: Group; e: Expense }) {
  const { from, to } = ends(e)
  const [adding, setAdding] = useState(false)
  return <>
    {from === ME && e.pending && !e.rejected && <button className="btn secondary" onClick={() => setAdding(true)}><Icon n="plus" />{e.proof ? 'Update proof' : 'Add proof'}</button>}
    {adding && <ProofSheet gid={g.id} eid={e.id} payee={who(g, to)} onClose={() => setAdding(false)} />}
  </>
}
