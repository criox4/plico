// Search: groups, friends and expenses, straight from the phone's own copy (works offline, nothing leaves the device).
import { useState } from 'react'
import { inr, ME, balances } from './logic'
import type { State } from './store'
import { friendBalance, friendsOf } from './people'
import { Avatar, LedgerRow, Screen, SectionHead, go } from './ui'
import { Icon } from './icons'

export function Search({ s }: { s: State }) {
  const [q, setQ] = useState('')
  const t = q.trim().toLowerCase()
  const digits = t.replace(/[₹,\s]/g, '')
  const groups = t ? s.groups.filter(g => g.kind !== 'direct' && g.name.toLowerCase().includes(t)) : []
  const friends = t ? friendsOf(s).filter(f => f.email !== s.user?.email?.toLowerCase() && (f.name.toLowerCase().includes(t) || f.email.includes(t))) : []
  const expenses = t ? s.groups.flatMap(g => g.expenses.map((e, i) => ({ g, e, i })))
    .filter(({ e }) => e.title.toLowerCase().includes(t) || (/^\d+(\.\d+)?$/.test(digits) && String(e.amount / 100).startsWith(digits)))
    .sort((a, b) => b.e.date.localeCompare(a.e.date)).slice(0, 30) : []
  const none = t && !groups.length && !friends.length && !expenses.length
  return (
    <Screen t={s.theme} back title="Search">
      <label className="field search-field">
        <span className="sr-only">Search</span>
        <Icon n="search" />
        <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Groups, friends, expenses or an amount" autoFocus enterKeyHint="search" />
      </label>
      {!t && <p className="muted-p">Search everything you share, even offline. Try a place, a name, or an amount like 840.</p>}
      {none && <p className="muted-p">Nothing matches “{q.trim()}”.</p>}
      {groups.length > 0 && <>
        <SectionHead title="Groups" />
        <ul className="friends">{groups.map(g => { const n = balances(g)[ME] ?? 0; return (
          <li key={g.id}><button className="friend-row" onClick={() => go('/g/' + g.id)}>
            <span className="slip-kind">{g.emoji ? <span className="slip-emoji">{g.emoji}</span> : <Icon n={g.kind} />}</span>
            <span className="grow"><strong>{g.name}</strong><small>{g.members.length} people · {g.expenses.length} expenses</small></span>
            <span className={`money ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}`}>{n ? inr(n) : 'even'}</span>
          </button></li>) })}</ul>
      </>}
      {friends.length > 0 && <>
        <SectionHead title="Friends" />
        <ul className="friends">{friends.map(f => { const n = friendBalance(f); return (
          <li key={f.email}><button className="friend-row" onClick={() => go('/f/' + encodeURIComponent(f.email))}>
            <Avatar name={f.name} image={f.image} size={40} />
            <span className="grow"><strong>{f.name}</strong><small>{f.email}</small></span>
            <span className={`money ${n > 0 ? 'pos' : n < 0 ? 'neg' : ''}`}>{n ? inr(n) : 'settled'}</span>
          </button></li>) })}</ul>
      </>}
      {expenses.length > 0 && <>
        <SectionHead title="Expenses" />
        <ol className="ledger">{expenses.map(({ g, e, i }) => <LedgerRow key={g.id + e.id} g={g} e={e} serial={i + 1} showGroup />)}</ol>
      </>}
    </Screen>
  )
}
