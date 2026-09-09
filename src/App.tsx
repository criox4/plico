import { useEffect, useState, type ReactNode } from 'react'
import { ME, addMonth, decodeShare, inr, isVpa, runRecurring, split, toPaise, today, uid, upiLink,
  type Expense, type Group, type Id, type Kind, type SplitMode, type Tone } from './logic'
import { replaceAll, update, useStore, type State } from './store'
import { THEMES, ensureFonts, theme, themeVars, type ThemeId } from './themes'
import { CATS, Icon } from './icons'
import { Denomination, GroupView, Home, KINDS, PUBLIC, Screen, Settle, TONES, go, useQr, useRoute, who } from './ui'
import Gallery from './Gallery'

const back = () => (history.length > 1 ? history.back() : go('/'))
const edit = (gid: Id, fn: (g: Group) => void) => update(d => { const g = d.groups.find(x => x.id === gid); if (g) fn(g) })
const digits = (v: string) => v.replace(/[^\d.]/g, '')
const num = (v?: string) => parseFloat((v ?? '').replace(/,/g, '')) || 0

export default function App() {
  const s = useStore()
  const r = useRoute()
  useEffect(() => {
    ensureFonts([s.theme, ...s.groups.map(g => g.theme)])
    document.body.style.background = theme(s.theme).c.bg
  }, [s])

  if (r[0] === 'themes') return <Gallery />
  if (r[0] === 's') return <SharedPay p={r[1] ?? ''} />
  if (r[0] === 'me') return <Profile s={s} />
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
        edit(g.id, x => { x.expenses.push({ id: uid(), title: 'Settlement', cat: 'check', date: today(), amount: p, paid: { [from]: p }, owed: { [to]: p }, settle: true }) })
        back()
      }
      return <Settle s={s} g={g} from={from} to={to} amount={+r[5]} onRecord={record} />
    }
    return <GroupView s={s} g={g} />
  }
  return <Home s={s} t={s.theme} />
}

// ---------- shared form bits ----------
function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (t: ThemeId) => void }) {
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

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
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
        {first && <p className="lede">Money together, your way.</p>}
        <h1 className="q">What are we splitting?</h1>
        <div className="kinds">
          {(Object.keys(KINDS) as Kind[]).map(k => (
            <button key={k} className="kind" onClick={() => { setKind(k); setTh(KINDS[k].theme) }}>
              <Icon n={k} size={28} /><span>{KINDS[k].label}</span>
            </button>
          ))}
        </div>
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
    setGroupId(id); setPayer(ME); setMulti(false); setPaidIn({}); setMode('equal'); setInp(flags(ng))
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
      id: old?.id ?? uid(), title: title.trim() || CATS.find(c => c.id === cat)!.label, cat, date, amount: total, paid, owed, mode, input,
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
        {total > 0 && error && <p className="error" role="alert">{error}</p>}
        <button className="btn primary" disabled={!total || !!error}>{old ? 'Save changes' : total ? `Add ${inr(total)}` : 'Add expense'}</button>
        {old && <button type="button" className="link danger" onClick={del}>Delete expense</button>}
      </form>
    </Screen>
  )
}

// ---------- group settings ----------
function GroupSettings({ s, g }: { s: State; g: Group }) {
  const [newName, setNewName] = useState('')
  const used = new Set(g.expenses.flatMap(e => [...Object.keys(e.paid), ...Object.keys(e.owed)]))
  const set = (fn: (x: Group) => void) => edit(g.id, fn)
  const setMember = (id: Id, fn: (m: Group['members'][number]) => void) => set(x => { const m = x.members.find(y => y.id === id); if (m) fn(m) })
  const add = () => {
    const n = newName.trim()
    if (!n) return
    set(x => { x.members.push({ id: uid(), name: n }) })
    setNewName('')
  }
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
          {g.members.map(m => {
            const upi = m.id === ME ? s.me.upi : m.upi ?? ''
            return (
              <li key={m.id} className="person">
                <div className="person-fields">
                  <input aria-label="Name" value={m.id === ME ? `${s.me.name || 'You'} (you)` : m.name} disabled={m.id === ME}
                    maxLength={40} onChange={e => setMember(m.id, y => { y.name = e.target.value })} />
                  <input aria-label={`${m.id === ME ? 'Your' : m.name + '’s'} UPI ID`} placeholder="UPI ID, e.g. name@okaxis" value={upi}
                    inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-invalid={!!upi && !isVpa(upi)}
                    onChange={e => {
                      const v = e.target.value.trim()
                      if (m.id === ME) update(d => { d.me.upi = v })
                      else setMember(m.id, y => { y.upi = v || undefined })
                    }} />
                </div>
                {m.id !== ME && !used.has(m.id) && (
                  <button type="button" className="iconbtn" aria-label={`Remove ${m.name}`} onClick={() => set(x => { x.members = x.members.filter(y => y.id !== m.id) })}><Icon n="close" /></button>
                )}
              </li>
            )
          })}
        </ul>
        <small>People with expenses can’t be removed.</small>
        <div className="add-person">
          <input value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === 'Enter' && add()} placeholder="Add a person" aria-label="New person’s name" maxLength={40} />
          <button type="button" className="btn-sm" onClick={add}>Add</button>
        </div>
        <button type="button" className="link danger" onClick={() => {
          if (!confirm(`Delete ${g.name} and all its expenses? This can’t be undone.`)) return
          location.replace('#/')
          update(d => { d.groups = d.groups.filter(x => x.id !== g.id) })
        }}>Delete group</button>
      </div>
    </Screen>
  )
}

// ---------- you ----------
function Profile({ s }: { s: State }) {
  const [backup, setBackup] = useState('')
  const [msg, setMsg] = useState('')
  const copy = async () => {
    const j = JSON.stringify(s)
    setBackup(j)
    try {
      await navigator.clipboard.writeText(j)
      setMsg('Backup copied. Paste it somewhere safe, like a note to yourself.')
    } catch {
      setMsg('Select the text below and copy it somewhere safe.')
    }
  }
  const restore = () => {
    try {
      const x = JSON.parse(backup)
      const ok = x && x.me && Array.isArray(x.groups) &&
        x.groups.every((g: Group) => g && typeof g.id === 'string' && Array.isArray(g.members) && Array.isArray(g.expenses))
      if (!ok) throw new Error()
      if (confirm('Replace everything on this device with this backup?')) { replaceAll(x); setMsg('Backup restored.') }
    } catch {
      setMsg('That doesn’t look like a Splittr backup. Nothing was changed.')
    }
  }
  return (
    <Screen t={s.theme} back title="You">
      <div className="form">
        <label className="field"><span>Your name</span><input value={s.me.name} maxLength={40} autoComplete="name" onChange={e => update(d => { d.me.name = e.target.value })} /></label>
        <label className="field"><span>Your UPI ID</span>
          <input value={s.me.upi} placeholder="name@okhdfcbank" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            aria-invalid={!!s.me.upi && !isVpa(s.me.upi)} onChange={e => update(d => { d.me.upi = e.target.value.trim() })} />
          <small>Friends pay you here. It appears on your pay links and QR codes.</small>
        </label>
        <h2 className="form-h">App theme</h2>
        <ThemePicker value={s.theme} onChange={t => update(d => { d.theme = t })} />
        <h2 className="form-h">Reminder tone</h2>
        <div className="seg" role="radiogroup" aria-label="Reminder tone">
          {(['gentle', 'normal', 'shameless'] as Tone[]).map(t => (
            <button type="button" key={t} role="radio" aria-checked={s.tone === t} className={s.tone === t ? 'on' : ''} onClick={() => update(d => { d.tone = t })}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <p className="preview-msg">{TONES[s.tone]('₹840', 'Arjun', "Goa '26")}</p>
        <h2 className="form-h">Backup</h2>
        <small>Everything lives on this device until sync arrives. Keep a copy somewhere safe.</small>
        <div className="row">
          <button type="button" className="btn secondary" onClick={copy}><Icon n="copy" />Copy backup</button>
          <button type="button" className="btn secondary" onClick={restore} disabled={!backup.trim()}>Restore</button>
        </div>
        <textarea value={backup} onChange={e => setBackup(e.target.value)} rows={4} placeholder="Paste a backup here, then tap Restore" aria-label="Backup data" />
        {msg && <p className="note" role="status">{msg}</p>}
        <a className="link" href="#/themes">See all 12 themes</a>
      </div>
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
        <small>Splittr splits group expenses and settles them over UPI.</small>
        <a className="btn secondary" href={`${PUBLIC}/#/`}>Open Splittr</a>
      </section>
    </Screen>
  )
}
