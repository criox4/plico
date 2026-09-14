import { useEffect, useState, type InputHTMLAttributes, type ReactNode } from 'react'
import { ME, addMonth, fromSplitwise, needsConfirm, parseSplitwise, type Splitwise, decodeShare, inr, isVpa, runRecurring, split, toPaise, today, uid, upiLink,
  type Expense, type Group, type Id, type Kind, type SplitMode, type Tone } from './logic'
import { update, useStore, type State } from './store'
import { api, fileUrl, pull, uploadImage, useSync } from './sync'
import { ensureFonts, theme, type ThemeId } from './themes'
import { CATS, Icon } from './icons'
import { Avatar, Denomination, count, ThemePicker, GroupView, Home, KINDS, PUBLIC, Plico, Screen, Settle, go, useQr, useRoute, wa, who } from './ui'
import { AccountHub, AppearancePage, AuthFlow, Claim, DeleteConfirm, DeletePage, DevicesPage, ProfilePage,
  RemindersPage, ResetPassword, SecurityPage, Splash, Verified, VerifyBanner } from './account'
import Gallery from './Gallery'

const back = () => (history.length > 1 ? history.back() : go('/'))
const edit = (gid: Id, fn: (g: Group) => void) => update(d => { const g = d.groups.find(x => x.id === gid); if (g) fn(g) })
const digits = (v: string) => v.replace(/[^\d.]/g, '')
const num = (v?: string) => parseFloat((v ?? '').replace(/,/g, '')) || 0

export default function App() {
  const s = useStore()
  const r = useRoute()
  const sync = useSync()
  useEffect(() => {
    ensureFonts([s.theme, ...s.groups.map(g => g.theme)])
    document.body.style.background = theme(s.theme).c.bg
  }, [s])

  if (r[0] === 'themes') return <Gallery />
  if (r[0] === 's') return <SharedPay p={r[1] ?? ''} />
  if (r[0] === 'reset') return <ResetPassword />
  if (sync.booting) return <Splash />
  if (!sync.authed) return <AuthFlow s={s} notice={r[0] === 'verified' ? 'Email verified. Sign in to continue.' : undefined} />
  if (r[0] === 'verified') return <Verified />
  if (r[0] === 'claim' && r[1]) return <Claim s={s} token={r[1]} />
  if (r[0] === 'delete' && r[1]) return <DeleteConfirm s={s} token={r[1]} />
  if (r[0] === 'join' && r[1]) return <JoinGroup s={s} code={r[1]} />
  if (r[0] === 'me') {
    const Page = { profile: ProfilePage, theme: AppearancePage, tone: RemindersPage, security: SecurityPage, devices: DevicesPage, delete: DeletePage }[r[1] ?? '']
    return Page ? <Page key={r[1]} s={s} /> : <AccountHub s={s} />
  }
  if (r[0] === 'import') return <ImportSplitwise s={s} />
  if (r[0] === 'new' || !s.groups.length) return <NewGroup s={s} />
  if (r[0] === 'add') return <ExpenseForm s={s} />
  const g = r[0] === 'g' ? s.groups.find(x => x.id === r[1]) : undefined
  if (g) {
    if (r[2] === 'add') return <ExpenseForm key="add" s={s} gid={g.id} />
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
  return <Home s={s} t={s.theme} banner={<VerifyBanner s={s} />} />
}

// ---------- shared form bits ----------
export function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" role="radio" aria-checked={on} className={`chip${on ? ' on' : ''}`} onClick={onClick}>{children}</button>
}

// ---------- onboarding / new group ----------
function NewGroup({ s }: { s: State }) {
  const first = !s.groups.length
  const [kind, setKind] = useState<Kind | null>(null)
  const [name, setName] = useState('')
  const [me, setMe] = useState(s.me.name)
  const [people, setPeople] = useState('')
  const [th, setTh] = useState<ThemeId>(s.theme)
  const names = people.split(',').map(x => x.trim()).filter(Boolean)

  if (!kind)
    return (
      <Screen t={s.theme} back={!first}>
        {first && <VerifyBanner s={s} />}
        {first && <div className="hello"><Plico mood="idle" size={56} /><p><strong>Hi. I’m Plico.</strong>I keep track of the awkward money stuff.</p></div>}
        <h1 className="q">Who’s spending together?</h1>
        <div className="kinds">
          {(Object.keys(KINDS) as Kind[]).map(k => (
            <button key={k} className="kind" onClick={() => { setKind(k); setTh(KINDS[k].theme) }}>
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
        id, name: name.trim() || KINDS[kind].hint, kind, theme: th, track: kind === 'family' || undefined,
        members: [{ id: ME, name: 'Me' }, ...names.map(n => ({ id: uid(), name: n }))], expenses: [],
      })
    })
    location.replace('#/g/' + id)
  }
  return (
    <Screen t={th} back={() => setKind(null)} title={`New ${KINDS[kind].label.toLowerCase()} group`}>
      <form className="form" onSubmit={e => { e.preventDefault(); create() }}>
        <label className="field"><span>Group name</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={KINDS[kind].hint} maxLength={40} autoFocus />
        </label>
        {!s.me.name && (
          <label className="field"><span>Your name</span>
            <input value={me} onChange={e => setMe(e.target.value)} autoComplete="name" required maxLength={40} />
          </label>
        )}
        <label className="field"><span>Who else is in?</span>
          <input value={people} onChange={e => setPeople(e.target.value)} placeholder="Rahul, Neha, Karan" />
          <small>Separate names with commas. They don’t need the app.</small>
        </label>
        <h2 className="form-h">Make it yours</h2>
        <ThemePicker value={th} onChange={setTh} />
        <small>Every group can have its own theme.</small>
        <button className="btn primary" disabled={!me.trim()}>Create group</button>
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

function ExpenseForm({ s, gid, eid }: { s: State; gid?: Id; eid?: Id }) {
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

  useEffect(() => { if (eid && !old) location.replace('#/g/' + g.id) }, [eid, old, g.id])
  if (eid && !old) return null

  const del = () => {
    if (!old || !confirm(old.settle ? 'Delete this settlement?' : `Delete “${old.title}”?`)) return
    edit(g.id, x => { x.expenses = x.expenses.filter(y => y.id !== old.id) })
    back()
  }

  if (old?.settle) {
    const [from, to] = [Object.keys(old.paid)[0], Object.keys(old.owed)[0]]
    return (
      <Screen t={g.theme} back title="Settlement">
        <section className="pay">
          <p className="pay-who">{who(g, from)} paid {who(g, to)}</p>
          <p className="pay-amt"><span className="money settled-ink">{inr(old.amount)}</span></p>
          <p className="pay-for">{new Date(old.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
        </section>
        <button className="btn secondary" onClick={del}>Delete settlement</button>
      </Screen>
    )
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
    if (gid) back()
    else location.replace('#/g/' + g.id)
  }

  return (
    <Screen t={g.theme} back title={old ? 'Edit expense' : 'Add expense'}>
      <form className="form" onSubmit={e => { e.preventDefault(); save() }}>
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
            {s.groups.map(x => <Chip key={x.id} on={x.id === g.id} onClick={() => pickGroup(x.id)}><Icon n={x.kind} size={18} />{x.name}</Chip>)}
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
        {old && <button type="button" className="link danger" onClick={del}>Delete expense</button>}
      </form>
    </Screen>
  )
}

/** Receipt photo: uploaded to the group's private files; shown only to its members. */
function ReceiptField({ gid, name, onChange }: { gid: Id; name?: string; onChange: (n?: string) => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!name) return setUrl('')
    let live = true, made = ''
    fileUrl(`/api/groups/${gid}/files/${name}`).then(u => { made = u; if (live) setUrl(u) }).catch(() => live && setErr('Couldn’t load the receipt photo.'))
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [gid, name])
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
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  )
}

// ---------- Splitwise import ----------
function ImportSplitwise({ s }: { s: State }) {
  const [data, setData] = useState<Splitwise | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [me, setMe] = useState(-1)
  const [kind, setKind] = useState<Kind>('friends')
  const read = async (f: File) => {
    setErr('')
    const r = parseSplitwise(await f.text())
    if ('error' in r) return setErr(r.error)
    if (!r.rows.length) return setErr('No expenses in rupees found in that file.')
    const first = s.me.name.trim().split(/\s+/)[0]?.toLowerCase()
    setData(r)
    setName(f.name.replace(/\.csv$/i, '').replace(/_\d{4}-\d{2}-\d{2}.*$/, '').replace(/[-_]+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase()).slice(0, 40) || 'Imported group')
    setMe(first ? r.people.findIndex(p => p.toLowerCase().startsWith(first)) : -1)
  }
  const doImport = () => {
    if (!data || me < 0) return
    const ids = data.people.map((_, i) => (i === me ? ME : uid()))
    const expenses = data.rows.map(r => fromSplitwise(r, ids)).filter(e => !!e)
    const id = uid()
    update(d => {
      d.groups.unshift({
        id, name: name.trim() || 'Imported group', kind, theme: KINDS[kind].theme, track: kind === 'family' || undefined,
        members: data.people.map((p, i) => (i === me ? { id: ME, name: 'Me' } : { id: ids[i], name: p.slice(0, 60) })), expenses,
      })
    })
    location.replace('#/g/' + id)
  }
  const spent = data?.rows.filter(r => !r.settle).reduce((a, r) => a + r.amount, 0) ?? 0
  return (
    <Screen t={s.theme} back title="Import from Splitwise">
      <div className="form">
        {!data ? <>
          <p className="muted-p">In Splitwise, open the group, tap the settings gear, then <strong>Export as spreadsheet</strong>. Pick that CSV file here. Balances come over exactly; people you add later can claim their spot.</p>
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
          <h2 className="form-h">Kind of group</h2>
          <div className="chips" role="radiogroup" aria-label="Kind of group">
            {(Object.keys(KINDS) as Kind[]).map(k => <Chip key={k} on={kind === k} onClick={() => setKind(k)}><Icon n={k} size={18} />{KINDS[k].label}</Chip>)}
          </div>
          <button className="btn primary" disabled={me < 0} onClick={doImport}>{me < 0 ? 'Pick which one is you' : `Import ${data.rows.length} entries`}</button>
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
  return (
    <Screen t={g.theme} back title="Group settings">
      <div className="form">
        <label className="field"><span>Name</span><input value={g.name} maxLength={40} onChange={e => set(x => { x.name = e.target.value })} /></label>
        <h2 className="form-h">Type</h2>
        <div className="chips" role="radiogroup" aria-label="Group type">
          {(Object.keys(KINDS) as Kind[]).map(k => <Chip key={k} on={g.kind === k} onClick={() => set(x => { x.kind = k })}><Icon n={k} size={18} />{KINDS[k].label}</Chip>)}
        </div>
        <label className="check"><input type="checkbox" checked={!!g.track} onChange={e => set(x => { x.track = e.target.checked || undefined })} />Tracking only: show balances, never nudge anyone to settle</label>
        <h2 className="form-h">Theme</h2>
        <ThemePicker value={g.theme} onChange={t => set(x => { x.theme = t })} />
        <h2 className="form-h">People</h2>
        <ul className="people">
          {g.members.map(m => <Person key={m.id} s={s} g={g} m={m} used={used.has(m.id)} />)}
        </ul>
        <AddPerson g={g} />
        <Invite g={g} />
        {g.mine !== false && (
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
const emailOk = (v = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
const phoneOk = (v = '') => /^\+?[0-9 ()-]{7,20}$/.test(v.trim())
const waNumber = (p: string) => { const d = p.replace(/\D/g, ''); return d.length === 10 ? '91' + d : d }

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
  const status = m.joined ? 'Joined' : m.invited ? 'Invited' : 'Guest'
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
        <span className="grow"><strong>{m.name}</strong><small>{m.email || m.phone || (m.joined ? 'Has Plico' : 'No contact yet')}</small></span>
        <span className={`chip-state ${m.joined ? 'ok' : m.invited ? 'info' : ''}`}>{status}</span>
      </button>
      {open && (
        <div className="person-body">
          {m.joined ? <p className="muted-p">{m.name} manages their own details. {m.upi && <>UPI: <code className="vpa">{m.upi}</code></>}</p> : <>
            <label className="field"><span>Name</span><CommitInput value={m.name} maxLength={40} onCommit={v => v && setMember(g, m.id, y => { y.name = v })} /></label>
            <label className="field"><span>Email</span>
              <CommitInput type="email" value={m.email ?? ''} placeholder="Gets an invite and sees this group after signing up" autoCapitalize="none"
                aria-invalid={!!m.email && !emailOk(m.email)} onCommit={v => setMember(g, m.id, y => { y.email = v || undefined })} />
            </label>
            <label className="field"><span>Phone</span>
              <CommitInput type="tel" value={m.phone ?? ''} placeholder="+91 98765 43210" aria-invalid={!!m.phone && !phoneOk(m.phone)}
                onCommit={v => setMember(g, m.id, y => { y.phone = v || undefined })} />
            </label>
            <label className="field"><span>UPI ID</span>
              <CommitInput value={m.upi ?? ''} placeholder="name@okaxis" inputMode="email" autoCapitalize="none" spellCheck={false}
                aria-invalid={!!m.upi && !isVpa(m.upi)} onCommit={v => setMember(g, m.id, y => { y.upi = v || undefined })} />
            </label>
            <div className="person-actions">
              {m.email && emailOk(m.email) && <button type="button" className="btn-sm" onClick={() => void resend()}><Icon n="send" size={16} />{m.invited ? 'Resend email' : 'Email invite'}</button>}
              {m.phone && phoneOk(m.phone) && link && <a className="btn-sm" href={`https://wa.me/${waNumber(m.phone)}?text=${encodeURIComponent(msg)}`} target="_blank" rel="noopener"><Icon n="send" size={16} />WhatsApp invite</a>}
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

function AddPerson({ g }: { g: Group }) {
  const [name, setName] = useState('')
  const [contact, setContact] = useState('')
  const c = contact.trim()
  const bad = !!c && !emailOk(c) && !phoneOk(c)
  const add = () => {
    if (!name.trim() || bad) return
    edit(g.id, x => { x.members.push({ id: uid(), name: name.trim(), ...(emailOk(c) ? { email: c.toLowerCase() } : phoneOk(c) ? { phone: c } : {}) }) })
    setName('')
    setContact('')
  }
  return (
    <form className="add-person-form" onSubmit={e => { e.preventDefault(); add() }}>
      <h2 className="form-h">Add someone</h2>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="Name" aria-label="Name" maxLength={40} />
      <input value={contact} onChange={e => setContact(e.target.value)} placeholder="Email or phone (optional)" aria-label="Email or phone" autoCapitalize="none" aria-invalid={bad} />
      <small>{emailOk(c) ? 'They’ll get an email invite. When they sign up with it, this group appears for them.' : phoneOk(c) ? 'Send them the WhatsApp invite from their row once added.' : 'Without contact details they stay a guest you track for them.'}</small>
      <button className="btn secondary" disabled={!name.trim() || bad}>Add {name.trim() || 'person'}</button>
    </form>
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
  type Inv = { id: string; name: string; kind: Kind; theme: ThemeId; joined: boolean; guests: { id: string; name: string }[] }
  const [inv, setInv] = useState<Inv | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api<Inv>(`/api/invites/${code}`).then(setInv, e => setErr(e.message)) }, [code])
  const join = async (memberId?: string) => {
    setBusy(true)
    try {
      const r = await api<{ id: string }>(`/api/invites/${code}/join`, { method: 'POST', body: JSON.stringify({ memberId }) })
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
          <p className="muted-p">Which one is you? Your balances in this group come with the name.</p>
          <div className="kinds">
            {inv.guests.map(m => <button key={m.id} className="kind" disabled={busy} onClick={() => void join(m.id)}><Icon n="user" size={24} /><span>{m.name}</span></button>)}
          </div>
          <button className="btn secondary" disabled={busy} onClick={() => void join()}>I’m not listed. Join as {s.me.name || 'me'}</button>
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
