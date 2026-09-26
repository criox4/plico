import { resumePush } from './push'
import { Suspense, lazy, useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { ME, addMonth, fromSplitwise, itemSplit, matchMember, needsConfirm, parseQuick, parseSplitwise, type Item, type Quick, type Splitwise, decodeShare, inr, isVpa, runRecurring, split, toPaise, today, uid, upiLink,
  type Expense, type Group, type Id, type Kind, type SplitMode, type Tone } from './logic'
import { update, useStore, type State } from './store'
import { api, pull, readExpense, refreshUser, uploadImage, useSync, type Read } from './sync'
import { takeShared } from './share'
import { ensureFonts, theme, type ThemeId } from './themes'
import { CATS, Icon } from './icons'
import { Avatar, Converge, Denomination, EMOJI, GROUP_KINDS, calm, count, useGroupImage, ThemePicker, GroupView, Home, KINDS, PUBLIC, Plico, Screen, Settle, go, useQr, useRoute, wa, who } from './ui'
import { AccountHub, AgeGate, InvitePreview, AppearancePage, AuthFlow, Claim, GuardianConsent, GuardianWait, PrivacyPage, DeleteConfirm, DeletePage, DevicesPage, ProfilePage,
  NotificationsPage, Onboarding, ResetPassword, SecurityPage, Splash, Verified, VerifyBanner } from './account'
import { Landing } from './Landing'
import { Capacitor } from '@capacitor/core'
import { Activity, AuditLog, ExpenseHistory, IssuesBanner, SyncIssues } from './history'
import { Search } from './search'
import { FriendPage, FriendSettle, Friends, PeoplePicker, emailOk, friendsOf, groupTitle, type Person as Pick } from './people'

const back = () => (history.length > 1 ? history.back() : go('/'))
const edit = (gid: Id, fn: (g: Group) => void) => update(d => { const g = d.groups.find(x => x.id === gid); if (g) fn(g) })
const digits = (v: string) => v.replace(/[^\d.]/g, '')
const num = (v?: string) => parseFloat((v ?? '').replace(/,/g, '')) || 0

// Every theme side by side, for design review. `npm run dev` only: left out of production builds.
const Gallery = import.meta.env.DEV ? lazy(() => import('./Gallery')) : null

export default function App() {
  const s = useStore()
  const r = useRoute()
  const sync = useSync()
  // Desktop: "/" opens search from anywhere that isn't a text field.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable && sync.authed) { e.preventDefault(); go('/search') }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [sync.authed])
  useEffect(() => { if (sync.authed && !sync.booting) void resumePush(sync.push, go) }, [sync.authed, sync.booting, sync.push])
  useEffect(() => {
    ensureFonts([s.theme, ...s.groups.map(g => g.theme)])
    document.body.style.background = theme(s.theme).c.bg
  }, [s])

  if (Gallery && r[0] === 'themes') return <Suspense fallback={null}><Gallery /></Suspense>
  if (r[0] === 's') return <SharedPay p={r[1] ?? ''} />
  if (r[0] === 'reset') return <ResetPassword />
  if (r[0] === 'guardian' && r[1]) return <GuardianConsent token={r[1]} />
  if (sync.booting) return <Splash />
  if (!sync.authed && (r[0] === 'join' || r[0] === 'claim') && r[1]) return <InvitePreview s={s} kind={r[0]} code={r[1]} />
  // plico.space, signed out, first visit on the web: the front door. Phone apps and returning people go straight to sign-in.
  if (!sync.authed && !Capacitor.isNativePlatform() && !s.user && !r[0]) return <Landing />
  if (!sync.authed && r[0] === 'signin') return <AuthFlow s={s} start="signin" />
  if (!sync.authed) return <AuthFlow s={s} notice={r[0] === 'verified' ? 'Email verified. Sign in to continue.' : undefined} />
  if (s.user && !s.user.ageGroup) return <AgeGate s={s} />
  if (s.user?.ageGroup === 'teen' && !s.user.guardianConsent) return <GuardianWait s={s} />
  if (s.user?.onboarded === false) return <Onboarding s={s} />
  if (r[0] === 'verified') return <Verified />
  if (r[0] === 'claim' && r[1]) return <Claim s={s} token={r[1]} />
  if (r[0] === 'delete' && r[1]) return <DeleteConfirm s={s} token={r[1]} />
  if (r[0] === 'join' && r[1]) return <JoinGroup s={s} code={r[1]} />
  if (r[0] === 'me') {
    const Page = { profile: ProfilePage, theme: AppearancePage, tone: NotificationsPage, notify: NotificationsPage, security: SecurityPage, devices: DevicesPage, delete: DeletePage, privacy: PrivacyPage }[r[1] ?? '']
    return Page ? <Page key={r[1]} s={s} /> : <AccountHub s={s} />
  }
  if (r[0] === 'import') return <ImportSplitwise s={s} />
  if (r[0] === 'sync') return <SyncIssues s={s} />
  if (r[0] === 'friends') return <Friends s={s} />
  if (r[0] === 'activity' || r[0] === 'log') return <Activity s={s} />
  if (r[0] === 'search') return <Search s={s} />
  if (r[0] === 'f' && r[1]) return r[2] === 'settle' ? <FriendSettle s={s} email={decodeURIComponent(r[1])} /> : <FriendPage s={s} email={decodeURIComponent(r[1])} />
  if (r[0] === 'new' || (r[0] === 'add' && !s.groups.length)) return <NewGroup key={r[1]} s={s} preset={r[0] === 'new' ? r[1] : undefined} />
  if (r[0] === 'add') return <ExpenseForm key={r[1] ?? 'add'} s={s} shared={r[1] === 'shared'} />
  const g = r[0] === 'g' ? s.groups.find(x => x.id === r[1]) : undefined
  if (g) {
    if (r[2] === 'add') return <ExpenseForm key="add" s={s} gid={g.id} />
    if (r[2] === 'sync') return <SyncIssues s={s} gid={g.id} />
    if (r[2] === 'audit') return <AuditLog s={s} g={g} />
    if (r[2] === 'e' && r[3] && r[4] === 'history') return <ExpenseHistory s={s} g={g} eid={r[3]} />
    if (r[2] === 'e' && r[3]) return <ExpenseForm key={r[3]} s={s} gid={g.id} eid={r[3]} />
    if (r[2] === 'edit') return <GroupSettings s={s} g={g} />
    if (r[2] === 'pay' && r[3] && r[4] && +r[5] > 0) {
      const [from, to] = [r[3], r[4]]
      const record = (p: number) => {
        edit(g.id, x => { x.expenses.push({ id: uid(), title: 'Settlement', cat: 'check', date: today(), amount: p, paid: { [from]: p }, owed: { [to]: p }, settle: true, ...(needsConfirm(x, to) && { pending: true }) }) })
        back()
      }
      return <Settle s={s} g={g} from={from} to={to} amount={+r[5]} onRecord={record} />
    }
    return <GroupView s={s} g={g} />
  }
  return <Home s={s} t={s.theme} banner={<><VerifyBanner s={s} /><IssuesBanner /></>} />
}

// ---------- shared form bits ----------
export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" role="radio" aria-checked={on} className={`chip${on ? ' on' : ''}`} onClick={onClick}>{children}</button>
}

// ---------- onboarding / new group ----------
function NewGroup({ s, preset }: { s: State; preset?: string }) {
  const [kind, setKind] = useState<Kind | null>(GROUP_KINDS.find(k => k === preset) ?? null)
  const [name, setName] = useState('')
  const [me, setMe] = useState(s.me.name)
  const [people, setPeople] = useState<Pick[]>([])

  if (!kind)
    return (
      <Screen t={s.theme} back>
        <h1 className="q">Who’s spending together?</h1>
        <div className="kinds">
          {GROUP_KINDS.map(k => (
            <button key={k} className="kind" onClick={() => setKind(k)}>
              <Icon n={k} size={28} /><span>{KINDS[k].label}</span>
            </button>
          ))}
        </div>
        <button className="link center-link" onClick={() => go('/import')}>Coming from Splitwise? Import a group</button>
      </Screen>
    )

  const create = () => {
    if (!me.trim()) return
    const id = uid()
    update(d => {
      d.me.name = me.trim()
      d.groups.unshift({
        id, name: name.trim() || KINDS[kind].hint, kind, theme: KINDS[kind].theme, track: kind === 'family' || undefined,
        members: [{ id: ME, name: 'Me' }, ...people.map(p => ({ id: uid(), name: p.name, email: p.email }))], expenses: [],
      })
    })
    location.replace('#/g/' + id)
  }
  return (
    <Screen t={s.theme} back={preset ? true : () => setKind(null)} title={`New ${KINDS[kind].label.toLowerCase()} group`}>
      <form className="form" onSubmit={e => { e.preventDefault(); create() }}>
        <label className="field"><span>Group name</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={KINDS[kind].hint} maxLength={40} autoFocus />
        </label>
        {!s.me.name && (
          <label className="field"><span>Your name</span>
            <input value={me} onChange={e => setMe(e.target.value)} autoComplete="name" required maxLength={40} />
          </label>
        )}
        <PeoplePicker s={s} value={people} onChange={setPeople} label="Who else is in?" />
        <small>Friends you’ve split with before show up as you type. Anyone new gets an email invite, and sees the group as soon as they join. You can change the theme later in group settings.</small>
        <button className="btn primary" disabled={!me.trim()}>{people.length ? `Create group with ${count(people.length, 'person', 'people')}` : 'Create group'}</button>
      </form>
    </Screen>
  )
}

// ---------- add / edit expense ----------
const MODES: { id: SplitMode; label: string; unit: string }[] = [
  { id: 'equal', label: 'Equally', unit: '' }, { id: 'exact', label: 'Amounts', unit: '₹' },
  { id: 'percent', label: 'Percent', unit: '%' }, { id: 'shares', label: 'Shares', unit: '×' },
]
const strs = (o: Record<Id, number>, k = 1) => Object.fromEntries(Object.entries(o).map(([i, v]) => [i, String(v / k)]))

function ExpenseForm({ s, gid, eid, shared }: { s: State; gid?: Id; eid?: Id; shared?: boolean }) {
  const [groupId, setGroupId] = useState(gid ?? s.groups[0].id)
  const g = s.groups.find(x => x.id === groupId) ?? s.groups[0]
  const old = eid ? g.expenses.find(e => e.id === eid) : undefined
  const flags = (grp: Group, on = '1') => Object.fromEntries(grp.members.map(m => [m.id, on]))
  const payers0 = old ? Object.keys(old.paid) : [ME]

  const [amt, setAmt] = useState(old ? String(old.amount / 100) : '')
  const [title, setTitle] = useState(old?.title ?? '')
  const [cat, setCat] = useState(old?.cat ?? 'food')
  const [date, setDate] = useState(old?.date ?? today())
  const [multi, setMulti] = useState(payers0.length > 1)
  const [payer, setPayer] = useState(payers0[0])
  const [paidIn, setPaidIn] = useState<Record<Id, string>>(old && payers0.length > 1 ? strs(old.paid, 100) : {})
  const [mode, setMode] = useState<SplitMode>(old?.mode ?? 'equal')
  const [inp, setInp] = useState<Record<Id, string>>(
    old?.input ? strs(old.input) : old ? Object.fromEntries(g.members.map(m => [m.id, old.owed[m.id] ? '1' : '0'])) : flags(g))
  const [adjust, setAdjust] = useState((old?.mode ?? 'equal') !== 'equal' || payers0.length > 1)
  const [repeat, setRepeat] = useState(!!old?.repeat)
  const [receipt, setReceipt] = useState(old?.receipt)
  const [done, setDone] = useState<Expense | null>(null)
  // capture: type it, scan it, or arrive with something shared from another app
  const sync = useSync()
  const [quick, setQuick] = useState('')
  const [reading, setReading] = useState(false)
  const [capErr, setCapErr] = useState('')
  const [items, setItems] = useState<Item[] | null>(null)
  const [extras, setExtras] = useState(0)

  useEffect(() => { if (eid && !old) location.replace('#/g/' + g.id) }, [eid, old, g.id])
  useEffect(() => {
    if (!shared) return
    void takeShared().then(p => {
      if (p?.image) scan(p.image)
      else if (p?.text) { setQuick(p.text.slice(0, 200)); void typeIt(p.text.slice(0, 200)) }
    })
  }, [shared]) // eslint-disable-line react-hooks/exhaustive-deps
  if (done) return <Converge s={s} g={g} e={done} />
  if (eid && !old) return null

  const del = () => {
    if (!old || !confirm(`${old.settle ? 'Delete this settlement?' : `Delete “${old.title}”?`} You can restore it from the group’s activity.`)) return
    edit(g.id, x => { x.expenses = x.expenses.filter(y => y.id !== old.id) })
    back()
  }

  if (old?.settle) {
    const [from, to] = [Object.keys(old.paid)[0], Object.keys(old.owed)[0]]
    return (
      <Screen t={s.theme} back title="Settlement">
        <section className="pay">
          <p className="pay-who">{who(g, from)} paid {who(g, to)}</p>
          <p className="pay-amt"><span className="money settled-ink">{inr(old.amount)}</span></p>
          <p className="pay-for">{new Date(old.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </section>
        <button className="btn secondary" onClick={del}>Delete settlement</button>
        <button className="link center-link" onClick={() => go(`/g/${g.id}/e/${old.id}/history`)}>See history</button>
      </Screen>
    )
  }

  const applyQuick = (q: Quick) => {
    if (q.amount) setAmt(String(q.amount / 100))
    if (q.title) setTitle(q.title.slice(0, 80))
    if (q.cat) setCat(q.cat)
    if (q.payer) { setMulti(false); setPayer(q.payer) }
    if (q.people?.length) { setMode('equal'); setInp(Object.fromEntries(g.members.map(m => [m.id, q.people!.includes(m.id) ? '1' : '0']))) }
  }
  const fromRead = (r: Read) => {
    const who = (n: string) => matchMember(n, g.members)
    applyQuick({ amount: r.amount ? Math.round(r.amount * 100) : undefined, title: r.title || undefined,
      payer: r.payer ? who(r.payer) : undefined, people: r.people.map(who).filter((x): x is Id => !!x) })
    if (CATS.some(c => c.id === r.cat)) setCat(r.cat)
    if (r.date && r.date <= today()) setDate(r.date)
    if (r.items.length > 1) { setItems(r.items.map(i => ({ name: i.name, amount: Math.round(i.amount * 100), who: g.members.map(m => m.id) }))); setExtras(Math.round(r.extras * 100)) }
  }
  const typeIt = async (text = quick) => {
    if (!text.trim()) return
    applyQuick(parseQuick(text, g.members)) // instant and offline; AI refines when it can
    if (!sync.ai || !s.user?.ai || !navigator.onLine) return // unless AI reading is switched off (Privacy and data)
    setReading(true); setCapErr('')
    try { fromRead(await readExpense({ text, groupId: g.id })) } catch { /* the rule-based read already filled what it could */ } finally { setReading(false) }
  }
  const scan = (f: Blob) => {
    if (!sync.ai) return setCapErr('Reading photos isn’t set up yet. Type it in instead.')
    if (!s.user?.ai) return setCapErr('AI reading is off. Turn it on in You › Privacy and data, or type it in.')
    void readPhoto(f)
  }
  const readPhoto = async (f: Blob) => {
    setReading(true); setCapErr('')
    try {
      const [r] = await Promise.all([readExpense({ image: f, groupId: g.id }),
        uploadImage<{ name: string }>(`/api/groups/${g.id}/files`, f, 1600).then(x => setReceipt(x.name)).catch(() => {})])
      if (!r.amount && !r.items.length) setCapErr('Couldn’t find an amount in that photo. Type it in instead.')
      fromRead(r)
    } catch (e) { setCapErr((e as Error).message) } finally { setReading(false) }
  }
  const useItems = () => {
    if (!items) return
    const r = itemSplit(items, extras)
    if ('error' in r) return setCapErr(r.error)
    const res = r.owed
    const sum = Object.values(res).reduce((a, b) => a + b, 0)
    setAmt(String(sum / 100)); setMode('exact'); setAdjust(true)
    setInp(Object.fromEntries(g.members.map(m => [m.id, res[m.id] ? String(res[m.id] / 100) : ''])))
    setItems(null); setCapErr('')
  }

  const pickGroup = (id: Id) => {
    const ng = s.groups.find(x => x.id === id)!
    setGroupId(id); setReceipt(undefined); setPayer(ME); setMulti(false); setPaidIn({}); setMode('equal'); setInp(flags(ng))
  }
  const switchMode = (m: SplitMode) => { setMode(m); setInp(flags(g, m === 'equal' ? '1' : '')) }

  const total = toPaise(amt)
  const input: Record<Id, number> = Object.fromEntries(g.members.map(m => {
    const v = inp[m.id]
    return [m.id, mode === 'equal' ? (v === '0' ? 0 : 1) : mode === 'shares' && !v ? 1 : num(v)]
  }))
  const res = split(total, mode, input)
  const owed = 'owed' in res ? res.owed : {}
  const paid: Record<Id, number> = multi
    ? Object.fromEntries(Object.entries(paidIn).map(([k, v]) => [k, toPaise(v)] as const).filter(([, v]) => v > 0))
    : { [payer]: total }
  const paidSum = Object.values(paid).reduce((a, b) => a + b, 0)
  const error = 'error' in res ? res.error : paidSum !== total ? `Payers add up to ${inr(paidSum)}, not ${inr(total)}` : ''

  const save = () => {
    if (!total || error) return
    const day = +date.slice(8)
    const e: Expense = {
      id: old?.id ?? uid(), title: title.trim() || CATS.find(c => c.id === cat)!.label, cat, date, amount: total, paid, owed, mode, input, receipt,
      repeat: repeat ? old?.repeat ?? { next: addMonth(date, day), day } : undefined,
    }
    edit(g.id, x => {
      const i = x.expenses.findIndex(y => y.id === e.id)
      if (i >= 0) x.expenses[i] = e
      else x.expenses.push(e)
      runRecurring(x)
    })
    const leave = () => (gid ? back() : location.replace('#/g/' + g.id))
    if (old || calm()) return leave()
    setDone(e) // a beat to see the split land, then on to the group
    setTimeout(leave, 1500)
  }

  return (
    <Screen t={s.theme} back title={old ? 'Edit expense' : 'Add expense'}>
      <form className="form" onSubmit={e => { e.preventDefault(); save() }}>
        {!old && (
          <div className="capture">
            <input className="quick-in" placeholder="Type it: Dinner 3200, Karan paid, except Riya" aria-label="Type the expense in a sentence" value={quick} maxLength={200}
              enterKeyHint="done" onChange={e => setQuick(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void typeIt() } }} onBlur={() => void typeIt()} />
            <label className="iconbtn scan" aria-label="Scan a receipt or screenshot" title="Scan a receipt or screenshot">
              <input type="file" accept="image/*" className="sr-only" disabled={reading} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) scan(f) }} />
              <Icon n="qr" />
            </label>
          </div>
        )}
        {!old && sync.ai && s.user?.ai && <p className="legal-line">Photos and typed text are read by AI (OpenAI, via OpenRouter; not stored or trained on). <a href="#/me/privacy">Turn off</a></p>}
        {reading && <p className="reading" role="status"><Plico mood="thinking" size={28} />Reading it…</p>}
        {capErr && <p className="error" role="alert">{capErr}</p>}
        {items && (
          <section className="items" aria-label="Split by item">
            <h2 className="form-h">Who had what?</h2>
            <ul className="rows">
              {items.map((it, i) => (
                <li className="item-row" key={i}>
                  <span className="grow">{it.name}</span><span className="money">{inr(it.amount)}</span>
                  <span className="item-who">
                    {g.members.map(m => {
                      const on = it.who.includes(m.id)
                      return <button type="button" key={m.id} className={`who-chip${on ? ' on' : ''}`} aria-pressed={on} aria-label={`${who(g, m.id)} had ${it.name}`}
                        onClick={() => setItems(items.map((x, j) => (j !== i ? x : { ...x, who: on ? x.who.filter(w => w !== m.id) : [...x.who, m.id] })))}>{who(g, m.id)}</button>
                    })}
                  </span>
                </li>
              ))}
            </ul>
            {extras !== 0 && <p className="muted-p">{extras > 0 ? 'Taxes, delivery and tips' : 'Discounts'} of {inr(Math.abs(extras))} are shared in proportion to what each person had.</p>}
            <div className="row">
              <button type="button" className="btn primary" onClick={useItems}>Use this split</button>
              <button type="button" className="btn secondary" onClick={() => setItems(null)}>Just the total</button>
            </div>
          </section>
        )}
        <label className="amount-field">
          <span className="sr-only">Amount in rupees</span>
          <span className="amount-cur" aria-hidden>₹</span>
          <input className="amount-in" inputMode="decimal" placeholder="0" value={amt} autoFocus={!old} onChange={e => setAmt(digits(e.target.value))} />
        </label>
        <input className="title-in" placeholder="What was it for?" aria-label="Description" value={title} maxLength={80} onChange={e => setTitle(e.target.value)} />
        <div className="chips scroll" role="radiogroup" aria-label="Category">
          {CATS.map(c => <Chip key={c.id} on={cat === c.id} onClick={() => setCat(c.id)}><Icon n={c.id} size={18} />{c.label}</Chip>)}
        </div>

        {!old && s.groups.length > 1 && <>
          <h2 className="form-h">Group</h2>
          <div className="chips scroll" role="radiogroup" aria-label="Group">
            {s.groups.map(x => <Chip key={x.id} on={x.id === g.id} onClick={() => pickGroup(x.id)}><Icon n={x.kind} size={18} />{groupTitle(x)}</Chip>)}
          </div>
        </>}

        <h2 className="form-h">Paid by</h2>
        <div className="chips" role="radiogroup" aria-label="Paid by">
          {g.members.map(m => <Chip key={m.id} on={!multi && payer === m.id} onClick={() => { setMulti(false); setPayer(m.id) }}>{who(g, m.id)}</Chip>)}
          <Chip on={multi} onClick={() => { setMulti(true); setAdjust(true) }}>Several people</Chip>
        </div>
        {multi && (
          <ul className="rows">
            {g.members.map(m => (
              <li className="row-in" key={m.id}>
                <span className="grow">{who(g, m.id)}</span>
                <input className="num" inputMode="decimal" placeholder="0" aria-label={`${who(g, m.id)} paid, rupees`}
                  value={paidIn[m.id] ?? ''} onChange={e => setPaidIn({ ...paidIn, [m.id]: digits(e.target.value) })} />
                <span className="unit">₹</span>
              </li>
            ))}
          </ul>
        )}

        <div className="section-head">
          <h2 className="form-h">Split {MODES.find(m => m.id === mode)!.label.toLowerCase()}</h2>
          {!adjust && <button type="button" className="link" onClick={() => setAdjust(true)}>Adjust split</button>}
        </div>
        {adjust && (
          <div className="seg" role="radiogroup" aria-label="Split method">
            {MODES.map(m => <button type="button" key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => switchMode(m.id)}>{m.label}</button>)}
          </div>
        )}
        <ul className="rows">
          {g.members.map(m => (
            <li className="row-in" key={m.id}>
              {mode === 'equal' ? (
                <label className="check">
                  <input type="checkbox" checked={inp[m.id] !== '0'} onChange={e => setInp({ ...inp, [m.id]: e.target.checked ? '1' : '0' })} />
                  {who(g, m.id)}
                </label>
              ) : <>
                <span className="grow">{who(g, m.id)}</span>
                <input className="num" inputMode="decimal" placeholder={mode === 'shares' ? '1' : '0'} aria-label={`${who(g, m.id)}, ${MODES.find(x => x.id === mode)!.label.toLowerCase()}`}
                  value={inp[m.id] ?? ''} onChange={e => setInp({ ...inp, [m.id]: digits(e.target.value) })} />
                <span className="unit">{MODES.find(x => x.id === mode)!.unit}</span>
              </>}
              <span className="share">{owed[m.id] ? inr(owed[m.id]) : '–'}</span>
            </li>
          ))}
        </ul>

        <label className="check"><input type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} />Repeats every month</label>
        <label className="field"><span>Date</span><input type="date" value={date} onChange={e => setDate(e.target.value || today())} /></label>
        <ReceiptField gid={g.id} name={receipt} onChange={setReceipt} />
        {total > 0 && error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={!total || !!error}>{old ? 'Save changes' : total ? `Add ${inr(total)}` : 'Add expense'}</button>
        {old && <button type="button" className="link center-link" onClick={() => go(`/g/${g.id}/e/${old.id}/history`)}>See history: who changed what</button>}
        {old && <button type="button" className="link danger" onClick={del}>Delete expense</button>}
      </form>
    </Screen>
  )
}

/** Receipt photo: uploaded to the group's private files; shown only to its members. */
function ReceiptField({ gid, name, onChange }: { gid: Id; name?: string; onChange: (n?: string) => void }) {
  const { url, failed } = useGroupImage(gid, name)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pick = async (f: File) => {
    setBusy(true); setErr('')
    try { onChange((await uploadImage<{ name: string }>(`/api/groups/${gid}/files`, f, 1600)).name) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="receipt">
      {name ? <>
        <a className="receipt-img" href={url || undefined} target="_blank" rel="noopener">{url ? <img src={url} alt="Receipt photo" /> : <span>Loading photo…</span>}</a>
        <button type="button" className="link danger" onClick={() => onChange(undefined)}>Remove photo</button>
      </> : (
        <label className="btn secondary" aria-busy={busy}>
          <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f) }} />
          <Icon n="plus" />{busy ? 'Uploading…' : 'Add receipt photo'}
        </label>
      )}
      {(err || failed) && <p className="error" role="alert">{err || 'Couldn’t load the receipt photo.'}</p>}
    </div>
  )
}

/** Group look: an emoji face for home and an optional cover photo. */
function GroupLook({ g, set }: { g: Group; set: (fn: (x: Group) => void) => void }) {
  const cover = useGroupImage(g.id, g.cover)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pick = async (f: File) => {
    setBusy(true); setErr('')
    try { const { name } = await uploadImage<{ name: string }>(`/api/groups/${g.id}/files`, f, 1600); set(x => { x.cover = name }) }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  return <>
    <h2 className="form-h">Emoji</h2>
    <div className="emoji-grid" role="radiogroup" aria-label="Group emoji">
      {EMOJI.map(x => <button type="button" key={x} role="radio" aria-checked={g.emoji === x} onClick={() => set(y => { y.emoji = y.emoji === x ? undefined : x })}>{x}</button>)}
    </div>
    <h2 className="form-h">Cover photo</h2>
    {g.cover ? <>
      <div className="group-cover">{cover.url && <img src={cover.url} alt="Group cover" />}</div>
      <button type="button" className="link danger" onClick={() => set(x => { x.cover = undefined })}>Remove cover</button>
    </> : (
      <label className="btn secondary" aria-busy={busy}>
        <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void pick(f) }} />
        <Icon n="plus" />{busy ? 'Uploading…' : 'Add a cover photo'}
      </label>
    )}
    {err && <p className="error" role="alert">{err}</p>}
  </>
}

// ---------- Splitwise import ----------
function ImportSplitwise({ s }: { s: State }) {
  const [data, setData] = useState<Splitwise | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [me, setMe] = useState(-1)
  const [kind, setKind] = useState<Kind>('friends')
  const [emails, setEmails] = useState<string[]>([])
  const friends = new Map(friendsOf(s).map(f => [f.name.toLowerCase(), f.email]))
  const read = async (f: File) => {
    setErr('')
    const r = parseSplitwise(await f.text())
    if ('error' in r) return setErr(r.error)
    if (!r.rows.length) return setErr('No expenses in rupees found in that file.')
    const first = s.me.name.trim().split(/\s+/)[0]?.toLowerCase()
    setData(r)
    setName(f.name.replace(/\.csv$/i, '').replace(/_\d{4}-\d{2}-\d{2}.*$/, '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40) || 'Imported group')
    setMe(first ? r.people.findIndex(p => p.toLowerCase().startsWith(first)) : -1)
    setEmails(r.people.map(p => friends.get(p.toLowerCase()) ?? '')) // friends you already have, by name
  }
  const doImport = () => {
    if (!data || me < 0 || missing) return
    const ids = data.people.map((_, i) => (i === me ? ME : uid()))
    const expenses = data.rows.map(r => fromSplitwise(r, ids)).filter(e => !!e)
    const id = uid()
    update(d => {
      d.groups.unshift({
        id, name: name.trim() || 'Imported group', kind, theme: KINDS[kind].theme, track: kind === 'family' || undefined,
        members: data.people.map((p, i) => (i === me ? { id: ME, name: 'Me' } : { id: ids[i], name: p.slice(0, 60), email: emails[i].trim().toLowerCase() })), expenses,
      })
    })
    location.replace('#/g/' + id)
  }
  const spent = data?.rows.filter(r => !r.settle).reduce((a, r) => a + r.amount, 0) ?? 0
  const missing = !!data && data.people.some((_, i) => i !== me && !emailOk(emails[i] ?? ''))
  return (
    <Screen t={s.theme} back title="Import from Splitwise">
      <div className="form">
        {!data ? <>
          <p className="muted-p">In Splitwise, open the group, tap the settings gear, then <strong>Export as spreadsheet</strong>. Pick that CSV file here. Balances come over exactly, and everyone gets an invite by email.</p>
          <label className="btn primary">
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f) }} />
            <Icon n="plus" />Choose CSV file
          </label>
        </> : <>
          <p className="notice">Found {count(data.rows.filter(r => !r.settle).length, 'expense', 'expenses')} ({inr(spent)}) and {count(data.rows.filter(r => r.settle).length, 'payment', 'payments')}.{data.skipped ? ` Left out ${count(data.skipped, 'row', 'rows')} in other currencies or without a date.` : ''}</p>
          <label className="field"><span>Group name</span><input value={name} maxLength={40} onChange={e => setName(e.target.value)} /></label>
          <h2 className="form-h">Which one is you?</h2>
          <div className="chips" role="radiogroup" aria-label="Which one is you">
            {data.people.map((p, i) => <Chip key={p + i} on={me === i} onClick={() => setMe(i)}>{p}</Chip>)}
          </div>
          {me >= 0 && <>
            <h2 className="form-h">Their emails</h2>
            <p className="muted-p">Everyone gets an invite, and sees these balances as soon as they join.</p>
            {data.people.map((p, i) => i === me ? null : (
              <label className="field" key={p + i}><span>{p}</span>
                <input type="email" value={emails[i] ?? ''} autoCapitalize="none" placeholder="their@email.com" aria-invalid={!!emails[i] && !emailOk(emails[i])}
                  onChange={e => setEmails(emails.map((x, k) => (k === i ? e.target.value : x)))} />
              </label>
            ))}
          </>}
          <h2 className="form-h">Kind of group</h2>
          <div className="chips" role="radiogroup" aria-label="Kind of group">
            {GROUP_KINDS.map(k => <Chip key={k} on={kind === k} onClick={() => setKind(k)}><Icon n={k} size={18} />{KINDS[k].label}</Chip>)}
          </div>
          <button className="btn primary" disabled={me < 0 || missing} onClick={doImport}>{me < 0 ? 'Pick which one is you' : missing ? 'Add everyone’s email' : `Import ${data.rows.length} entries`}</button>
          <button className="link center-link" onClick={() => setData(null)}>Choose a different file</button>
        </>}
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    </Screen>
  )
}

// ---------- group settings ----------
function GroupSettings({ s, g }: { s: State; g: Group }) {
  const used = new Set(g.expenses.flatMap(e => [...Object.keys(e.paid), ...Object.keys(e.owed)]))
  const set = (fn: (x: Group) => void) => edit(g.id, fn)
  const direct = g.kind === 'direct'
  const [adding, setAdding] = useState<Pick[]>([])
  const addAll = () => { set(x => { x.members.push(...adding.map(p => ({ id: uid(), name: p.name, email: p.email }))) }); setAdding([]) }
  return (
    <Screen t={s.theme} back title={direct ? `You and ${groupTitle(g)}` : 'Group settings'}>
      <div className="form">
        {!direct && <>
          <label className="field"><span>Name</span><input value={g.name} maxLength={40} onChange={e => set(x => { x.name = e.target.value })} /></label>
          <h2 className="form-h">Type</h2>
          <div className="chips" role="radiogroup" aria-label="Group type">
            {GROUP_KINDS.map(k => <Chip key={k} on={g.kind === k} onClick={() => set(x => { x.kind = k })}><Icon n={k} size={18} />{KINDS[k].label}</Chip>)}
          </div>
          <label className="check"><input type="checkbox" checked={!!g.track} onChange={e => set(x => { x.track = e.target.checked || undefined })} />Tracking only: show balances, never nudge anyone to settle</label>
        </>}
        <h2 className="form-h">Theme</h2>
        <ThemePicker value={g.theme} onChange={t => set(x => { x.theme = t })} />
        <small>{direct ? 'Shared with' : 'Everyone in'} {direct ? groupTitle(g) : g.name} sees this theme. Changes show in the audit log.</small>
        {!direct && <GroupLook g={g} set={set} />}
        {!direct && <>
          <h2 className="form-h">People</h2>
          <ul className="people">
            {g.members.map(m => <Person key={m.id} s={s} g={g} m={m} used={used.has(m.id)} />)}
          </ul>
          <PeoplePicker s={s} value={adding} onChange={setAdding} taken={g.members.map(m => m.email ?? '').filter(Boolean)} />
          {adding.length > 0 && <button type="button" className="btn primary" onClick={addAll}>Add {count(adding.length, 'person', 'people')} to {g.name}</button>}
          <Invite g={g} />
        </>}
        <button type="button" className="link center-link" onClick={() => go(`/g/${g.id}/audit`)}><Icon n="log" size={18} />Audit log</button>
        {!direct && g.mine !== false && (
          <button type="button" className="link danger" onClick={() => {
            if (!confirm(`Delete ${g.name} and all its expenses for everyone in it? This can’t be undone.`)) return
            location.replace('#/')
            update(d => { d.groups = d.groups.filter(x => x.id !== g.id) })
          }}>Delete group</button>
        )}
      </div>
    </Screen>
  )
}

// ---------- people + invites ----------
type M = Group['members'][number]
const setMember = (g: Group, id: Id, fn: (m: M) => void) => edit(g.id, x => { const m = x.members.find(y => y.id === id); if (m) fn(m) })

/** Text input that commits on blur/Enter, so half-typed emails never trigger an invite. */
function CommitInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <input {...rest} value={v} onChange={e => setV(e.target.value)} onBlur={() => v.trim() !== value && onCommit(v.trim())}
    onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} />
}

function Person({ s, g, m, used }: { s: State; g: Group; m: M; used: boolean }) {
  const [open, setOpen] = useState(false)
  const [link, setLink] = useState('')
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!open || m.joined || m.id === ME) return
    api<{ link: string }>(`/api/groups/${g.id}/members/${m.id}/invite`, { method: 'POST', body: '{}' })
      .then(r => setLink(r.link), () => setLink(''))
  }, [open, m.joined, m.id, g.id])
  if (m.id === ME)
    return (
      <li className="person">
        <Avatar name={s.me.name} image={s.user?.image} size={40} />
        <span className="grow"><strong>{s.me.name || 'You'} (you)</strong><small>{s.me.upi || 'Add your UPI ID in Account'}</small></span>
      </li>
    )
  const status = m.joined ? 'On Plico' : 'Invited'
  const resend = async () => {
    try {
      await api(`/api/groups/${g.id}/members/${m.id}/invite`, { method: 'POST', body: JSON.stringify({ email: true }) })
      setNote(`Invite sent to ${m.email}.`)
    } catch (e) { setNote((e as Error).message) }
  }
  const msg = `Hi ${m.name}! I added you to “${g.name}” on Plico so we can split and settle up. Join here: ${link}`
  return (
    <li className={`person${open ? ' open' : ''}`}>
      <button type="button" className="person-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Avatar name={m.name} image={m.image} size={40} />
        <span className="grow"><strong>{m.name}</strong><small>{m.email}</small></span>
        <span className={`chip-state ${m.joined ? 'ok' : 'info'}`}>{status}</span>
      </button>
      {open && (
        <div className="person-body">
          {m.joined ? <p className="muted-p">{m.name} manages their own details. {m.upi && <>UPI: <code className="vpa">{m.upi}</code></>}</p> : <>
            <label className="field"><span>Name</span><CommitInput value={m.name} maxLength={40} onCommit={v => v && setMember(g, m.id, y => { y.name = v })} /></label>
            <label className="field"><span>Email</span>
              <CommitInput type="email" value={m.email ?? ''} autoCapitalize="none" aria-invalid={!!m.email && !emailOk(m.email)}
                onCommit={v => emailOk(v) && setMember(g, m.id, y => { y.email = v.toLowerCase() })} />
              <small>Fixing a typo sends a fresh invite and cancels the old link.</small>
            </label>
            <label className="field"><span>UPI ID</span>
              <CommitInput value={m.upi ?? ''} placeholder="name@okaxis" inputMode="email" autoCapitalize="none" spellCheck={false}
                aria-invalid={!!m.upi && !isVpa(m.upi)} onCommit={v => setMember(g, m.id, y => { y.upi = v || undefined })} />
            </label>
            <div className="person-actions">
              {m.email && emailOk(m.email) && <button type="button" className="btn-sm" onClick={() => void resend()}><Icon n="send" size={16} />{m.invited ? 'Resend email' : 'Email invite'}</button>}
              {link && <a className="btn-sm" href={wa(msg)} target="_blank" rel="noopener"><Icon n="send" size={16} />WhatsApp</a>}
              {link && <button type="button" className="btn-sm ghost" onClick={() => { void navigator.clipboard?.writeText(link); setNote('Invite link copied.') }}><Icon n="copy" size={16} />Copy link</button>}
            </div>
            {!link && <small>Invite links appear once this person has synced. Check your connection.</small>}
          </>}
          {note && <p className="notice" role="status">{note}</p>}
          {!used && !m.joined && (
            <button type="button" className="link danger" onClick={() => edit(g.id, x => { x.members = x.members.filter(y => y.id !== m.id) })}>Remove {m.name}</button>
          )}
          {used && !m.joined && <small>{m.name} has expenses, so they can’t be removed.</small>}
        </div>
      )}
    </li>
  )
}

// ---------- group invite link ----------
function Invite({ g }: { g: Group }) {
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  useEffect(() => { api<{ code: string }>(`/api/groups/${g.id}/invite`).then(r => setCode(r.code), () => setErr('The invite link appears once this group has synced. Check your connection.')) }, [g.id])
  const link = code ? `${PUBLIC}/#/join/${code}` : ''
  const qr = useQr(link)
  return <>
    <h2 className="form-h">Invite people</h2>
    {link ? <>
      <p className="muted-p">Friends open this link, sign in, and pick which name in the group is theirs.</p>
      {qr && <div className="qr-plate qr-sm"><img src={qr} alt={`QR code to join ${g.name}`} /></div>}
      <a className="btn secondary" href={wa(`Join “${g.name}” on Plico so we can split and settle up: ${link}`)} target="_blank" rel="noopener"><Icon n="send" />Share invite on WhatsApp</a>
      <button type="button" className="link center-link" onClick={() => navigator.clipboard?.writeText(link)}><Icon n="copy" size={18} />Copy invite link</button>
    </> : <p className="muted-p">{err || 'Loading invite link…'}</p>}
  </>
}

function JoinGroup({ s, code }: { s: State; code: string }) {
  type Inv = { id: string; name: string; kind: Kind; theme: ThemeId; joined: boolean; people: number }
  const [inv, setInv] = useState<Inv | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<Inv>(`/api/invites/${code}`).then(setInv, e => setErr(e.message)) }, [code])
  const join = async () => {
    setBusy(true)
    try {
      const r = await api<{ id: string }>(`/api/invites/${code}/join`, { method: 'POST', body: '{}' })
      await pull()
      location.replace('#/g/' + r.id)
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }
  useEffect(() => { if (inv?.joined) location.replace('#/g/' + inv.id) }, [inv])
  const t = inv?.theme ?? s.theme
  return (
    <Screen t={t} back title="Join group">
      {!inv ? <p className="empty">{err || 'Opening invite…'}</p> : (
        <div className="form">
          <h1 className="q">{inv.name}</h1>
          <p className="muted-p">{count(inv.people, 'person is', 'people are')} splitting here. If someone added you by email, you get that spot and its balance.</p>
          <button className="btn primary" disabled={busy} onClick={() => void join()}>Join as {s.me.name || 'me'}</button>
          {err && <p className="error" role="alert">{err}</p>}
        </div>
      )}
    </Screen>
  )
}

// ---------- public pay page (no install needed) ----------
function SharedPay({ p }: { p: string }) {
  const d = decodeShare(p)
  const link = d?.v && isVpa(d.v) ? upiLink(d.v, d.t, d.a, `${d.g} settlement`) : ''
  const qr = useQr(link)
  if (!d) return <Screen t="classic"><p className="empty">This link looks broken. Ask whoever sent it for a fresh one.</p></Screen>
  return (
    <Screen t="classic">
      <Denomination t="classic" amount={-d.a} line={`${d.f}, you owe ${d.t}`} caption={d.g} />
      {link ? <>
        <section className="pay" aria-label="Payment details">
          <p className="pay-who">You are paying</p>
          <p className="payee">{d.t}</p>
          <code className="vpa">{d.v}</code>
          <p className="pay-for">For {d.g} settlement</p>
          {qr && <div className="qr-plate"><img src={qr} alt={`UPI QR code to pay ${d.t} ${inr(d.a)}`} /></div>}
        </section>
        <a className="btn primary" href={link}><Icon n="send" />Pay {inr(d.a)} via UPI</a>
        <p className="note"><Icon n="check" size={18} /><span>Check that your UPI app shows <strong>{d.t}</strong> before you pay.</span></p>
      </> : <p className="note"><span>{d.t} hasn’t added a UPI ID yet. Pay them directly.</span></p>}
      <section className="cta">
        <strong>Keep track of the whole group</strong>
        <small>Plico splits group expenses and settles them over UPI.</small>
        <a className="btn secondary" href={`${PUBLIC}/#/`}>Open Plico</a>
      </section>
    </Screen>
  )
}
