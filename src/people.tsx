// People: everyone is an account, or an invited email or phone. Friends are everyone you share a group with (one per
// person: see friendsIn), with the balance between the two of you across every group; direct expenses live in a two-person group.
import { useEffect, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import { ME, findFriend, friendsIn, inr, normPhone, needsConfirm, pairwise, today, uid, type Friend, type Group, type Id } from './logic'
import { update, type State } from './store'
import { api, pull, syncNow } from './sync'
import { Avatar, Denomination, LedgerRow, Plico, Screen, SectionHead, Settle, TONES, count, go, groupTitle, wa, SegPill } from './ui'
export { groupTitle }
import { Icon } from './icons'

export const emailOk = (v = '') => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
/** "riya.sen@x.com" → "Riya Sen": a starting point for the name, which they can change. */
export const guessName = (email: string) =>
  email.split('@')[0].split(/[._+-]+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 40) || 'Friend'

export type { Friend }
export const friendsOf = (s: State) => friendsIn(s.groups, s.user ?? undefined)
/** The friend a /f/<key> address names (older links carry a bare email). */
export const friendBy = (s: State, k: string) => findFriend(friendsOf(s), k)
/** How a friend shows under their name: their email, else their phone. */
export const contactOf = (f: { email?: string; phone?: string }) => f.email ?? f.phone ?? ''
export const friendPath = (f: Friend) => '/f/' + encodeURIComponent(f.key)
/** Positive: they owe you. Across every group you share, from the expenses themselves. */
export const friendBalance = (f: Friend) => f.spots.reduce((a, x) => a + pairwise(x.g, ME, x.id), 0)
const owesLine = (n: number) => (n > 0 ? `owes you ${inr(n)}` : n < 0 ? `you owe ${inr(n)}` : 'settled up')

/** Who POST /api/friends is about: their account once joined, else the email or phone they're invited by. */
export type FriendTarget = { userId: string } | { email: string } | { phone: string }
export const targetOf = (k: string): FriendTarget => {
  const [, t, v] = /^([uep]):(.+)$/.exec(k) ?? [, 'e', k]
  return t === 'u' ? { userId: v } : t === 'p' ? { phone: v } : { email: v }
}
/** The two-person group for expenses with this friend outside any group (made on the server, once per pair).
 * `link`: their personal claim link, when they're a phone number not on Plico yet. */
export async function directWith(to: FriendTarget, name: string) {
  const r = await api<{ id: string; link?: string }>('/api/friends', { method: 'POST', body: JSON.stringify({ ...to, name }) })
  await syncNow(); await pull()
  return r
}

// ---------- the people picker: friends as you type, or invite a new email or phone ----------
export type Person = { name: string; email?: string; phone?: string; userId?: string }
const keyOf = (p: Person) => (p.userId ? 'u:' + p.userId : p.email ? 'e:' + p.email : 'p:' + p.phone)
export function PeoplePicker({ s, value, onChange, taken = [], label = 'Add people' }: {
  s: State; value: Person[]; onChange: (v: Person[]) => void; taken?: string[]; label?: string // taken: emails, phones or account ids already in
}) {
  const [q, setQ] = useState('')
  const [name, setName] = useState<string | null>(null)
  const friends = friendsOf(s)
  const used = new Set([...taken, ...value.flatMap(v => [v.email, v.phone, v.userId]), s.user?.email].filter(Boolean).map(x => x!.toLowerCase()))
  const isUsed = (f: Friend) => [f.email, f.phone, f.uid].some(x => x && used.has(x.toLowerCase()))
  const t = q.trim(), lc = t.toLowerCase()
  const email = emailOk(t) ? lc : '', phone = email ? '' : normPhone(t) ?? '', contact = email || phone
  const hits = lc ? friends.filter(f => !isUsed(f) && (f.name.toLowerCase().includes(lc) || contactOf(f).includes(lc) || (!!phone && f.phone === phone))).slice(0, 6) : []
  const fresh = !!contact && !used.has(contact) && !friends.some(f => f.email === contact || f.phone === contact)
  const newName = (name ?? (email ? guessName(email) : '')).trim() // a number says nothing about a name: they type it
  const add = (p: Person) => { onChange([...value, p]); setQ(''); setName(null) }
  const pick = (f: Friend) => add({ name: f.name, email: f.email, phone: f.phone, userId: f.uid })
  const addNew = () => { if (newName) add({ name: newName, ...(email ? { email } : { phone }) }) }
  return (
    <div className="picker">
      {value.length > 0 && (
        <ul className="picked" aria-label="Added">
          {value.map(p => (
            <li key={keyOf(p)}>
              <Avatar name={p.name} size={28} />
              <span><strong>{p.name}</strong><small>{contactOf(p)}</small></span>
              <button type="button" className="iconbtn" aria-label={`Remove ${p.name}`} onClick={() => onChange(value.filter(v => v !== p))}><Icon n="close" size={18} /></button>
            </li>
          ))}
        </ul>
      )}
      <label className="field"><span>{label}</span>
        <input value={q} onChange={e => { setQ(e.target.value); setName(null) }} placeholder="Name, email or phone" autoCapitalize="none" autoComplete="off" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (fresh) addNew(); else if (hits[0]) pick(hits[0]) } }} />
      </label>
      {hits.length > 0 && (
        <ul className="suggest">
          {hits.map(f => (
            <li key={f.key}><button type="button" onClick={() => pick(f)}>
              <Avatar name={f.name} image={f.image} size={32} />
              <span><strong>{f.name}</strong><small>{contactOf(f)}{f.joined ? '' : ' · invited'}</small></span>
              <Icon n="plus" size={18} />
            </button></li>
          ))}
        </ul>
      )}
      {fresh && (
        <div className="invite-new">
          <label className="field"><span>Their name</span><input value={name ?? newName} onChange={e => setName(e.target.value)} maxLength={40} required={!!phone}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addNew() } }} /></label>
          <button type="button" className="btn secondary" disabled={!newName} onClick={addNew}><Icon n={email ? 'send' : 'plus'} size={18} />{email ? `Invite ${email}` : 'Add'}</button>
          <small>{email ? 'They get an email invite.' : 'You can send them an invite on WhatsApp next.'} Their spot and their share wait for them until they join.</small>
        </div>
      )}
      {t && !contact && !hits.length && <small>No friend called that yet. Type their email or phone number to invite them: everyone in a group has Plico, so everyone sees who paid what.</small>}
      {contact && !fresh && !hits.length && <small>Already added.</small>}
    </div>
  )
}

/** A spot's personal claim link. A spot added a moment ago may not have reached the server yet, so a few tries. */
export function useInviteLink(gid: Id, mid: Id, on = true) {
  const [link, setLink] = useState('')
  useEffect(() => {
    if (!on) return
    let live = true
    const get = (n: number): void => void api<{ link: string }>(`/api/groups/${gid}/members/${mid}/invite`, { method: 'POST', body: '{}' })
      .then(r => { if (live) setLink(r.link) }, () => { if (live && n) setTimeout(() => get(n - 1), 1500) })
    get(3)
    return () => { live = false }
  }, [gid, mid, on])
  return link
}
const inviteText = (name: string, link: string, group?: string) =>
  `Hi ${name.split(' ')[0]}! I added you ${group ? `to “${group}” ` : ''}on Plico so we can split and settle up. Join here: ${link}`
/** Straight to their WhatsApp chat, with their own link: they join as the spot you made for them. */
export function WhatsAppInvite({ g, m, className = 'btn secondary' }: { g: Group; m: Group['members'][number]; className?: string }) {
  const link = useInviteLink(g.id, m.id, !m.joined && !!m.phone)
  if (m.joined || !m.phone) return null
  return link ? <a className={className} href={wa(inviteText(m.name, link, g.kind === 'direct' ? undefined : g.name), m.phone)} target="_blank" rel="noopener"><Icon n="send" size={18} />Send {m.name.split(' ')[0]} an invite on WhatsApp</a>
    : <small>Getting {m.name.split(' ')[0]}’s invite link…</small>
}

// ---------- Friends tab ----------
type Filter = 'all' | 'owed' | 'owe' | 'even'
export function Friends({ s }: { s: State }) {
  const fs = friendsOf(s)
  const rows = fs.map(f => ({ f, n: friendBalance(f) })).sort((a, b) => Math.abs(b.n) - Math.abs(a.n) || a.f.name.localeCompare(b.f.name))
  const total = rows.reduce((a, r) => a + r.n, 0)
  const collect = rows.reduce((a, r) => a + Math.max(r.n, 0), 0), pay = rows.reduce((a, r) => a + Math.max(-r.n, 0), 0)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(location.hash.endsWith('/friends/add'))
  const t = q.trim().toLowerCase()
  const shown = rows.filter(({ f, n }) => (filter === 'all' || (filter === 'owed' ? n > 0 : filter === 'owe' ? n < 0 : !n))
    && (!t || f.name.toLowerCase().includes(t) || contactOf(f).includes(t)))
  const counts = { all: rows.length, owed: rows.filter(r => r.n > 0).length, owe: rows.filter(r => r.n < 0).length, even: rows.filter(r => !r.n).length }
  return (
    <Screen t={s.theme} fab="/add" title="Friends">
      <Denomination t={s.theme} amount={total} line={total > 0 ? 'Friends owe you' : total < 0 ? 'You owe friends' : 'All square with friends'}
        caption={collect && pay ? `${inr(collect)} to collect · ${inr(pay)} to pay` : undefined} />
      <SectionHead title={rows.length ? count(rows.length, 'friend', 'friends') : 'Friends'}
        action={<button className="link" aria-expanded={adding} onClick={() => setAdding(!adding)}>{adding ? 'Close' : 'Add a friend'}</button>} />
      {adding && <AddFriend s={s} onDone={() => setAdding(false)} />}
      {rows.length > 3 && (
        <div className="seg friend-filter" role="tablist" aria-label="Show">
          {([['all', 'All'], ['owed', 'Owe you'], ['owe', 'You owe'], ['even', 'Settled']] as [Filter, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{filter === id && <SegPill id="friends" />}{label}<small>{counts[id]}</small></button>
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
              <li key={f.key}><button className="friend-row" onClick={() => go(friendPath(f))}>
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

function AddFriend({ s, onDone }: { s: State; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [sent, setSent] = useState<{ p: Person; link: string } | null>(null)
  const open = (p: Person) => { onDone(); go('/f/' + encodeURIComponent(keyOf(p))) }
  const add = async (p?: Person) => {
    if (!p || busy) return
    setBusy(true); setErr('')
    try {
      const r = await directWith(targetOf(keyOf(p)), p.name)
      if (r.link && p.phone && !p.email && !p.userId) setSent({ p, link: r.link }); else open(p)
    } catch (x) { setErr(navigator.onLine ? (x as Error).message : 'Adding a friend needs a connection.') } finally { setBusy(false) }
  }
  if (sent) return (
    <div className="form add-friend">
      <p className="notice" role="status">{sent.p.name} isn’t on Plico yet. Send them their invite, straight to their WhatsApp.</p>
      <a className="btn primary" href={wa(inviteText(sent.p.name, sent.link), sent.p.phone)} target="_blank" rel="noopener"><Icon n="send" size={18} />Send invite on WhatsApp</a>
      <button type="button" className="link center-link" onClick={() => open(sent.p)}>Done</button>
    </div>
  )
  return (
    <div className="form add-friend">
      <PeoplePicker s={s} value={[]} onChange={v => void add(v[0])} label="Who?" />
      {busy && <p className="muted-p" role="status">Adding…</p>}
      {err && <p className="error" role="alert">{err}</p>}
      <small>Not on Plico yet? They get an invite, and expenses with them wait until they join.</small>
    </div>
  )
}

// ---------- one friend ----------
export function FriendPage({ s, k }: { s: State; k: string }) {
  const f = friendBy(s, k)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (!f) return <Screen t={s.theme} back title="Friend"><p className="empty">Not found. They may have left your groups.</p></Screen>
  const n = friendBalance(f)
  const parts = f.spots.map(x => ({ ...x, n: pairwise(x.g, ME, x.id) })).filter(x => x.n)
  const addExpense = () => go(`/add/f/${encodeURIComponent(f.key)}`) // the ledger with them is made on save if it doesn't exist yet
  const nudge = `${TONES[s.tone](inr(n), s.me.name || 'me', 'Plico')}${s.me.upi ? `\nUPI: ${s.me.upi}` : ''}`
  const list = (f.direct?.expenses ?? []).map((e, i) => ({ e, i })).sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
  return (
    <Screen t={s.theme} back title={f.name}>
      <div className="friend-head"><Avatar name={f.name} image={f.image} size={56} /><p><strong>{f.name}</strong><small>{contactOf(f)} · {f.joined ? 'On Plico' : 'Invited, hasn’t joined yet'}</small></p></div>
      <Denomination t={s.theme} amount={n} line={n > 0 ? `${f.name} owes you` : n < 0 ? `You owe ${f.name}` : 'All square'} />
      <div className="row friend-actions">
        <button className="btn primary" disabled={busy} onClick={() => void addExpense()}><Icon n="plus" size={18} />Add expense</button>
        {n !== 0 && <button className="btn secondary" onClick={() => go(`${friendPath(f)}/settle`)}>Settle up</button>}
      </div>
      {!f.joined && f.direct && <WhatsAppInvite g={f.direct} m={f.direct.members.find(m => m.id !== ME)!} className="link center-link" />}
      {n > 0 && <a className="link center-link" href={wa(nudge, f.phone)} target="_blank" rel="noopener"><Icon n="bell" size={16} />Remind {f.name} on WhatsApp</a>}
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
        <ol className="ledger"><AnimatePresence initial={false}>{list.map(({ e, i }) => <LedgerRow key={e.id} g={f.direct!} e={e} serial={i + 1} />)}</AnimatePresence></ol>
      </>}
    </Screen>
  )
}

/**
 * Settle everything with a friend in one UPI payment. It's recorded as one settlement in each group that has a
 * balance between you (largest first), so every group stays right; anything left over goes to your direct balance.
 */
export function FriendSettle({ s, k }: { s: State; k: string }) {
  const f = friendBy(s, k)
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
