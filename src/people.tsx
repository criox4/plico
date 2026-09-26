// People: everyone is an account or an invited email. Friends are everyone you share a group with (keyed by
// email), with the balance between the two of you across every group; direct expenses live in a two-person group.
import { useState } from 'react'
import { ME, inr, needsConfirm, pairwise, today, uid, type Group, type Id } from './logic'
import { update, type State } from './store'
import { api, pull, syncNow } from './sync'
import { Avatar, Denomination, LedgerRow, Plico, Screen, SectionHead, Settle, TONES, count, go, groupTitle, wa } from './ui'
export { groupTitle }
import { Icon } from './icons'

export const emailOk = (v = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
/** "riya.sen@x.com" → "Riya Sen": a starting point for the name, which they can change. */
export const guessName = (email: string) =>
  email.split('@')[0].split(/[._+-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 40) || 'Friend'

export type Friend = { email: string; name: string; image?: string; joined: boolean; spots: { g: Group; id: Id }[]; direct?: Group }
export function friendsOf(s: State): Friend[] {
  const by = new Map<string, Friend>()
  for (const g of s.groups) for (const m of g.members) {
    if (m.id === ME || !m.email) continue
    const f = by.get(m.email) ?? { email: m.email, name: m.name, joined: false, spots: [] }
    f.spots.push({ g, id: m.id })
    if (m.joined && !f.joined) { f.joined = true; f.name = m.name } // an account's own name wins over what someone typed
    f.image ||= m.image
    if (g.kind === 'direct') f.direct = g
    by.set(m.email, f)
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name))
}
/** Positive: they owe you. Across every group you share, from the expenses themselves. */
export const friendBalance = (f: Friend) => f.spots.reduce((a, x) => a + pairwise(x.g, ME, x.id), 0)
const owesLine = (n: number) => (n > 0 ? `owes you ${inr(n)}` : n < 0 ? `you owe ${inr(n)}` : 'settled up')

/** The two-person group for expenses with this friend outside any group (made on the server, once per pair). */
export async function directWith(email: string, name: string) {
  const { id } = await api<{ id: string }>('/api/friends', { method: 'POST', body: JSON.stringify({ email, name }) })
  await syncNow(); await pull()
  return id
}

// ---------- the people picker: friends as you type, or invite a new email ----------
export type Person = { name: string; email: string }
export function PeoplePicker({ s, value, onChange, taken = [], label = 'Add people' }: {
  s: State; value: Person[]; onChange: (v: Person[]) => void; taken?: string[]; label?: string
}) {
  const [q, setQ] = useState('')
  const [name, setName] = useState<string | null>(null)
  const friends = friendsOf(s).filter(f => f.email !== s.user?.email?.toLowerCase())
  const used = new Set([...taken, ...value.map(v => v.email), s.user?.email ?? ''].map(e => e.toLowerCase()))
  const t = q.trim().toLowerCase()
  const hits = t ? friends.filter(f => !used.has(f.email) && (f.name.toLowerCase().includes(t) || f.email.includes(t))).slice(0, 6) : []
  const fresh = emailOk(t) && !used.has(t) && !friends.some(f => f.email === t)
  const add = (p: Person) => { onChange([...value, { name: p.name.trim() || guessName(p.email), email: p.email.toLowerCase() }]); setQ(''); setName(null) }
  return (
    <div className="picker">
      {value.length > 0 && (
        <ul className="picked" aria-label="Added">
          {value.map(p => (
            <li key={p.email}>
              <Avatar name={p.name} size={28} />
              <span><strong>{p.name}</strong><small>{p.email}</small></span>
              <button type="button" className="iconbtn" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter(v => v !== p))}><Icon n="close" size={18} /></button>
            </li>
          ))}
        </ul>
      )}
      <label className="field"><span>{label}</span>
        <input value={q} onChange={e => { setQ(e.target.value); setName(null) }} placeholder="Name or email" autoCapitalize="none" autoComplete="off" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (fresh) add({ name: name ?? guessName(t), email: t }); else if (hits[0]) add(hits[0]) } }} />
      </label>
      {hits.length > 0 && (
        <ul className="suggest">
          {hits.map(f => (
            <li key={f.email}><button type="button" onClick={() => add(f)}>
              <Avatar name={f.name} image={f.image} size={32} />
              <span><strong>{f.name}</strong><small>{f.email}{f.joined ? '' : ' · invited'}</small></span>
              <Icon n="plus" size={18} />
            </button></li>
          ))}
        </ul>
      )}
      {fresh && (
        <div className="invite-new">
          <label className="field"><span>Their name</span><input value={name ?? guessName(t)} onChange={e => setName(e.target.value)} maxLength={40} /></label>
          <button type="button" className="btn secondary" onClick={() => add({ name: name ?? guessName(t), email: t })}><Icon n="send" size={18} />Invite {t}</button>
          <small>They get an email invite. Their spot and their share wait for them until they join.</small>
        </div>
      )}
      {t && !emailOk(t) && !hits.length && <small>No friend called that yet. Type their email to invite them: everyone in a group has Plico, so everyone sees who paid what.</small>}
      {emailOk(t) && used.has(t) && <small>Already added.</small>}
    </div>
  )
}

// ---------- Friends tab ----------
type Filter = 'all' | 'owed' | 'owe' | 'even'
export function Friends({ s }: { s: State }) {
  const fs = friendsOf(s).filter(f => f.email !== s.user?.email?.toLowerCase())
  const rows = fs.map(f => ({ f, n: friendBalance(f) })).sort((a, b) => Math.abs(b.n) - Math.abs(a.n) || a.f.name.localeCompare(b.f.name))
  const total = rows.reduce((a, r) => a + r.n, 0)
  const collect = rows.reduce((a, r) => a + Math.max(r.n, 0), 0), pay = rows.reduce((a, r) => a + Math.max(-r.n, 0), 0)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(location.hash.endsWith('/friends/add'))
  const t = q.trim().toLowerCase()
  const shown = rows.filter(({ f, n }) => (filter === 'all' || (filter === 'owed' ? n > 0 : filter === 'owe' ? n < 0 : !n))
    && (!t || f.name.toLowerCase().includes(t) || f.email.includes(t)))
  const counts = { all: rows.length, owed: rows.filter(r => r.n > 0).length, owe: rows.filter(r => r.n < 0).length, even: rows.filter(r => !r.n).length }
  return (
    <Screen t={s.theme} fab="/add" title="Friends">
      <Denomination t={s.theme} amount={total} line={total > 0 ? 'Friends owe you' : total < 0 ? 'You owe friends' : 'All square with friends'}
        caption={collect && pay ? `${inr(collect)} to collect · ${inr(pay)} to pay` : undefined} />
      <SectionHead title={rows.length ? count(rows.length, 'friend', 'friends') : 'Friends'}
        action={<button className="link" aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add a friend'}</button>} />
      {adding && <AddFriend onDone={() => setAdding(false)} />}
      {rows.length > 3 && (
        <div className="seg friend-filter" role="tablist" aria-label="Show">
          {([['all', 'All'], ['owed', 'Owe you'], ['owe', 'You owe'], ['even', 'Settled']] as [Filter, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{label}<small>{counts[id]}</small></button>
          ))}
        </div>
      )}
      {rows.length > 8 && (
        <label className="field search-field"><span className="sr-only">Find a friend</span><Icon n="search" />
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Find a friend" /></label>
      )}
      {rows.length ? (
        shown.length ? (
          <ol className="friends">
            {shown.map(({ f, n }) => (
              <li key={f.email}><button className="friend-row" onClick={() => go('/f/' + encodeURIComponent(f.email))}>
                <Avatar name={f.name} image={f.image} size={44} />
                <span className="grow"><strong>{f.name}</strong>
                  <small>{f.joined ? (f.spots.some(x => x.g.kind !== 'direct') ? `In ${count(f.spots.filter(x => x.g.kind !== 'direct').length, 'group', 'groups')}` : 'Just the two of you') : <span className="tag-invited">Invited</span>}</small></span>
                <span className={`money ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}`}>{n ? inr(n) : <Icon n="check" size={20} />}<small>{n > 0 ? 'owes you' : n < 0 ? 'you owe' : 'settled'}</small></span>
              </button></li>
            ))}
          </ol>
        ) : <p className="muted-p">Nobody here{t ? ` matching “${q.trim()}”` : ''}.</p>
      ) : (
        <div className="empty-state"><Plico mood="empty" size={72} /><p><strong>No friends yet.</strong> Everyone you share a group with shows up here. Add a friend to split a cab or a dinner for two, outside any group.</p></div>
      )}
      {!rows.length && !adding && <button className="btn primary" onClick={() => setAdding(true)}><Icon n="plus" size={18} />Add a friend</button>}
    </Screen>
  )
}

function AddFriend({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const e = email.trim().toLowerCase()
  const add = async () => {
    setBusy(true); setErr('')
    try { await directWith(e, (name ?? guessName(e)).trim()); onDone(); go('/f/' + encodeURIComponent(e)) }
    catch (x) { setErr(navigator.onLine ? (x as Error).message : 'Adding a friend needs a connection.') } finally { setBusy(false) }
  }
  return (
    <form className="form add-friend" onSubmit={x => { x.preventDefault(); if (emailOk(e)) void add() }}>
      <label className="field"><span>Their email</span><input type="email" value={email} onChange={x => { setEmail(x.target.value); setName(null) }} autoCapitalize="none" placeholder="friend@example.com" autoFocus /></label>
      {emailOk(e) && <label className="field"><span>Their name</span><input value={name ?? guessName(e)} onChange={x => setName(x.target.value)} maxLength={40} /></label>}
      {err && <p className="error" role="alert">{err}</p>}
      <button className="btn primary" disabled={!emailOk(e) || busy}>{busy ? 'Adding…' : 'Add friend'}</button>
      <small>Not on Plico yet? They get an invite, and expenses with them wait until they join.</small>
    </form>
  )
}

// ---------- one friend ----------
export function FriendPage({ s, email }: { s: State; email: string }) {
  const f = friendsOf(s).find(x => x.email === email)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!f) return <Screen t={s.theme} back title="Friend"><p className="empty">Not found. They may have left your groups.</p></Screen>
  const n = friendBalance(f)
  const parts = f.spots.map(x => ({ ...x, n: pairwise(x.g, ME, x.id) })).filter(x => x.n)
  const addExpense = async () => {
    if (f.direct) return go(`/g/${f.direct.id}/add`)
    setBusy(true); setErr('')
    try { go(`/g/${await directWith(f.email, f.name)}/add`) } catch (x) { setErr(navigator.onLine ? (x as Error).message : 'The first expense with a friend needs a connection.') } finally { setBusy(false) }
  }
  const nudge = `${TONES[s.tone](inr(n), s.me.name || 'me', 'Plico')}${s.me.upi ? `\nUPI: ${s.me.upi}` : ''}`
  const list = (f.direct?.expenses ?? []).map((e, i) => ({ e, i })).sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
  return (
    <Screen t={s.theme} back title={f.name}>
      <div className="friend-head"><Avatar name={f.name} image={f.image} size={56} /><p><strong>{f.name}</strong><small>{f.email} · {f.joined ? 'On Plico' : 'Invited, hasn’t joined yet'}</small></p></div>
      <Denomination t={s.theme} amount={n} line={n > 0 ? `${f.name} owes you` : n < 0 ? `You owe ${f.name}` : 'All square'} />
      <div className="row friend-actions">
        <button className="btn primary" disabled={busy} onClick={() => void addExpense()}><Icon n="plus" size={18} />Add expense</button>
        {n !== 0 && <button className="btn secondary" onClick={() => go(`/f/${encodeURIComponent(f.email)}/settle`)}>Settle up</button>}
      </div>
      {n > 0 && <a className="link center-link" href={wa(nudge)} target="_blank" rel="noopener"><Icon n="bell" size={16} />Remind {f.name} on WhatsApp</a>}
      {err && <p className="error" role="alert">{err}</p>}
      {parts.length > 0 && <>
        <SectionHead title="Where it comes from" />
        <ul className="rows">
          {parts.map(x => (
            <li key={x.g.id}><button className="row-in link-row" onClick={() => go('/g/' + x.g.id)}>
              <span className="grow">{x.g.kind === 'direct' ? 'Outside groups' : x.g.name}</span>
              <span className={`money ${x.n > 0 ? 'pos' : 'neg'}`}>{owesLine(x.n)}</span>
            </button></li>
          ))}
        </ul>
      </>}
      {list.length > 0 && f.direct && <>
        <SectionHead title="Just the two of you" />
        <ol className="ledger">{list.map(({ e, i }) => <LedgerRow key={e.id} g={f.direct!} e={e} serial={i + 1} />)}</ol>
      </>}
    </Screen>
  )
}

/**
 * Settle everything with a friend in one UPI payment. It's recorded as one settlement in each group that has a
 * balance between you (largest first), so every group stays right; anything left over goes to your direct balance.
 */
export function FriendSettle({ s, email }: { s: State; email: string }) {
  const f = friendsOf(s).find(x => x.email === email)
  if (!f) return <Screen t={s.theme} back title="Settle up"><p className="empty">Not found.</p></Screen>
  const n = friendBalance(f)
  const home = f.direct ? { g: f.direct, id: f.spots.find(x => x.g === f.direct)!.id } : f.spots[0]
  const iPay = n < 0
  const record = (paise: number) => {
    let left = paise
    update(d => {
      const all = f.spots.map(x => ({ g: d.groups.find(y => y.id === x.g.id)!, id: x.id })).filter(x => x.g).map(x => ({ ...x, n: pairwise(x.g, ME, x.id) }))
      const spots = all.filter(x => (iPay ? x.n < 0 : x.n > 0)).sort((a, b) => Math.abs(b.n) - Math.abs(a.n))
      const pay = (g: Group, id: Id, amt: number) => g.expenses.push({ id: uid(), title: 'Settlement', cat: 'check', date: today(), amount: amt,
        paid: { [iPay ? ME : id]: amt }, owed: { [iPay ? id : ME]: amt }, settle: true, ...(iPay && needsConfirm(g, id) && { pending: true }) })
      // They're paying you the net: groups where you owe them are cleared against it, so every group ends square.
      // Those offsets only reduce what you collect, and you're recording the payment yourself, so nothing waits on anyone.
      // (When you pay the net, your payment waits for their confirmation, so no offsets are recorded ahead of it.)
      if (!iPay && paise >= Math.abs(n)) for (const x of all.filter(x => x.n < 0)) {
        const amt = Math.abs(x.n)
        x.g.expenses.push({ id: uid(), title: 'Settlement (netted across groups)', cat: 'check', date: today(), amount: amt, paid: { [ME]: amt }, owed: { [x.id]: amt }, settle: true })
        left += amt
      }
      for (const x of spots) {
        if (left <= 0) break
        const amt = Math.min(left, Math.abs(x.n))
        pay(x.g, x.id, amt); left -= amt
      }
      const h = d.groups.find(y => y.id === home.g.id)
      if (left > 0 && h) pay(h, home.id, left)
    })
    history.length > 1 ? history.back() : go('/friends')
  }
  return <Settle s={s} g={home.g} from={iPay ? ME : home.id} to={iPay ? home.id : ME} amount={Math.abs(n)} onRecord={record} />
}
