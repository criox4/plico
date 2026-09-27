// Add expense: two ways in, one result. "Ask Plico" takes a sentence or a bill in conversation; "Enter it" is the
// form. Both say who it's with first (a group, or friends outside any group) and save through commitDraft().
import { useState, type ReactNode } from 'react'
import type { Group } from './logic'
import type { State } from './store'
import type { Target } from './draft'
import { friendsOf } from './people'
import { useSync } from './sync'
import { Chat, ASK_ADD } from './chat'
import { Avatar, Screen, count, go, groupTitle, SegPill } from './ui'
import { theme } from './themes'
import { Icon } from './icons'

const TAB = 'plico-add-tab'
const last = (g: Group) => g.expenses.reduce((a, e) => (e.date > a ? e.date : a), '')

/** The Add screen's frame: the two tabs when AI is on, just the form otherwise. */
export function AddScreen({ s, form, back }: { s: State; form: ReactNode; back?: boolean }) {
  const sync = useSync()
  const ai = sync.ai && !!s.user?.ai
  const [tab, setTab] = useState<'ask' | 'form'>(() => {
    try { return ai && navigator.onLine && localStorage.getItem(TAB) !== 'form' ? 'ask' : 'form' } catch { return 'form' }
  })
  const pick = (t: 'ask' | 'form') => { setTab(t); try { localStorage.setItem(TAB, t) } catch { /* a convenience */ } }
  return (
    <Screen t={s.theme} back={back ?? true} title="Add expense">
      {ai && (
        <div className="seg add-tabs" role="tablist" aria-label="How to add it">
          <button role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'on' : ''} onClick={() => pick('ask')}>{tab === 'ask' && <SegPill id="add" />}Ask Plico</button>
          <button role="tab" aria-selected={tab === 'form'} className={tab === 'form' ? 'on' : ''} onClick={() => pick('form')}>{tab === 'form' && <SegPill id="add" />}Enter it</button>
        </div>
      )}
      {ai && tab === 'ask'
        ? <div className="add-chat" role="tabpanel"><Chat suggestions={ASK_ADD} hint="Auto 250 with Bala, or attach a bill" onSaved={saved => {
            const [x] = saved
            if (!x) return
            go(saved.length > 1 ? '/friends' : x.friend ? `/f/${encodeURIComponent(x.friend)}` : `/g/${x.groupId}`)
          }} /></div>
        : <div role="tabpanel">{form}</div>}
    </Screen>
  )
}

/** Who's this with: nothing is assumed from the + button; a group, or one or more friends outside any group. */
export function WithPicker({ s, value, onChange, locked }: { s: State; value: Target | null; onChange: (t: Target) => void; locked?: boolean }) {
  const [open, setOpen] = useState(!value)
  const [q, setQ] = useState('')
  const t = q.trim().toLowerCase()
  const groups = s.groups.filter(g => g.kind !== 'direct' && (!t || g.name.toLowerCase().includes(t))).sort((a, b) => last(b).localeCompare(last(a)))
  const friends = friendsOf(s).filter(f => f.email !== s.user?.email?.toLowerCase() && (!t || f.name.toLowerCase().includes(t) || f.email.includes(t)))
    .sort((a, b) => Math.max(0, ...b.spots.map(x => +new Date(last(x.g) || 0))) - Math.max(0, ...a.spots.map(x => +new Date(last(x.g) || 0))) || a.name.localeCompare(b.name))
  const picked = value?.kind === 'friends' ? value.people.map(p => p.email) : []
  const toggle = (email: string, name: string) => {
    const people = value?.kind === 'friends' ? value.people : []
    const next = picked.includes(email) ? people.filter(p => p.email !== email) : [...people, { email, name }]
    if (next.length) onChange({ kind: 'friends', people: next })
  }
  const g = value?.kind === 'group' ? s.groups.find(x => x.id === value.groupId) : undefined
  return (
    <section className={`with${open ? ' open' : ''}`} aria-label="Who it’s with">
      <button type="button" className="with-now" aria-expanded={open} disabled={locked} onClick={() => setOpen(!open)}>
        {g ? <span className="slip-kind with-tile" style={{ background: theme(g.theme).c.accent, color: theme(g.theme).c.onAccent }}>{g.emoji ? <span className="slip-emoji">{g.emoji}</span> : <Icon n={g.kind} size={20} />}</span>
          : value?.kind === 'friends' ? <span className="with-faces">{value.people.slice(0, 3).map(p => <Avatar key={p.email} name={p.name} image={friendsOf(s).find(f => f.email === p.email)?.image} size={32} />)}</span>
          : <span className="with-tile empty"><Icon n="friends" size={20} /></span>}
        <span className="with-what">
          <small>{value ? 'With' : 'Start here'}</small>
          <strong>{g ? groupTitle(g) : value?.kind === 'friends' ? value.people.map(p => p.name.split(' ')[0]).join(', ') : 'Who’s this with?'}</strong>
          {value?.kind === 'friends' && <small>No group · on your ledger with {value.people.length === 1 ? 'them' : 'each of them'}</small>}
        </span>
        {!locked && (value || !open) && <span className="link with-change">{open ? 'Done' : value ? 'Change' : 'Choose'}</span>}
      </button>
      {open && !locked && (
        <div className="with-panel">
          <label className="field search-field"><span className="sr-only">Search groups and friends</span><Icon n="search" />
            <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Search groups and friends" autoFocus={!value} /></label>
          {groups.length > 0 && <>
            <h3 className="with-h">Groups</h3>
            <ul className="with-list">
              {groups.map(x => {
                return (
                  <li key={x.id}><button type="button" className={`with-row${value?.kind === 'group' && value.groupId === x.id ? ' on' : ''}`} aria-pressed={value?.kind === 'group' && value.groupId === x.id}
                    onClick={() => { onChange({ kind: 'group', groupId: x.id }); setOpen(false); setQ('') }}>
                    <span className="slip-kind with-tile" style={{ background: theme(x.theme).c.accent, color: theme(x.theme).c.onAccent }}>{x.emoji ? <span className="slip-emoji">{x.emoji}</span> : <Icon n={x.kind} size={18} />}</span>
                    <span className="grow"><strong>{x.name}</strong><small>{count(x.members.length, 'person', 'people')}</small></span>
                  </button></li>
                )
              })}
            </ul>
          </>}
          {friends.length > 0 && <>
            <h3 className="with-h">Friends <small>no group needed · pick one or more</small></h3>
            <ul className="with-list">
              {friends.map(f => (
                <li key={f.email}><label className={`with-row${picked.includes(f.email) ? ' on' : ''}`}>
                  <Avatar name={f.name} image={f.image} size={36} />
                  <span className="grow"><strong>{f.name}</strong><small>{f.email}</small></span>
                  <input type="checkbox" checked={picked.includes(f.email)} onChange={() => toggle(f.email, f.name)} />
                </label></li>
              ))}
            </ul>
          </>}
          {!groups.length && !friends.length && <p className="muted-p">{t ? `Nothing matches “${q.trim()}”.` : 'No groups or friends yet.'} <button type="button" className="link" onClick={() => go('/friends/add')}>Add a friend</button> or <button type="button" className="link" onClick={() => go('/new')}>make a group</button>.</p>}
          {picked.length > 0 && <button type="button" className="btn secondary" onClick={() => { setOpen(false); setQ('') }}>With {picked.length === 1 ? value?.kind === 'friends' && value.people[0].name : count(picked.length, 'friend', 'friends')}</button>}
        </div>
      )}
    </section>
  )
}
