// Sync issues (conflicts, refused changes), the money audit (group log, my money log, CSV) and one expense's history.
import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { GENESIS, ME, auditPayload, balances, changes, inr, summary, type Group, type Id, type Snap } from './logic'
import { theme, type ThemeId } from './themes'
import * as z from 'zod/mini'
import { ActivityOut, AuditEvent, AuditOut, SnapFull, type ActivityEvent } from './schema'
import { groupTitle } from './people'
import type { State } from './store'
import { api, bodySnap, resolveIssue, restoreExpense, revertExpense, seenActivity, useSync, type Issue, type ServerExpense } from './sync'
import { Avatar, Denomination, Plico, Screen, count, go } from './ui'
import { Icon } from './icons'

const when = (at: string) => {
  const d = new Date(at)
  const t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? `today, ${t}` : `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${t}`
}
/** Server member id → a name in sentences ("paid by you"). */
/** One version in the expense history: who did what, the changes, and the money it moved. */
function VersionLine({ s, g, e }: { s: State; g: Group; e: Event }) {
  const d = describe(e, g, s.user?.id)
  return <>
    <p><strong>{d.line.replace(/ “.*”$/, '')}</strong></p>
    {d.details.length > 0 && <ul className="changes">{d.details.map(w => <li key={w}>{cap(w)}</li>)}</ul>}
    {d.moves.length > 0 && <p className="moves">{d.moves.join(' · ')}</p>}
  </>
}
const namer = (g: Group | undefined) => (id: Id) => (id === g?.selfId ? 'you' : g?.members.find(m => m.id === id)?.name ?? 'someone')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// ---------- "N changes need you" ----------
export function IssuesBanner({ gid }: { gid?: Id }) {
  const n = useSync().issues.filter(i => !gid || i.gid === gid).length
  if (!n) return null
  return (
    <div className="confirm-card warn" role="status">
      <p><strong>{count(n, 'change needs you', 'changes need you')}</strong>
        <small>{gid ? 'Someone else changed the same thing, or a change couldn’t be saved.' : 'Some of your changes clashed with someone else’s, or couldn’t be saved.'}</small></p>
      <button className="btn-sm" onClick={() => go(gid ? `/g/${gid}/sync` : '/sync')}>Review</button>
    </div>
  )
}

// ---------- review conflicts and refused changes ----------
export function SyncIssues({ s, gid }: { s: State; gid?: Id }) {
  const all = useSync().issues.filter(i => !gid || i.gid === gid)
  const g = s.groups.find(x => x.id === gid)
  useEffect(() => { if (!all.length) history.length > 1 ? history.back() : go('/') }, [all.length])
  return (
    <Screen t={g?.theme ?? s.theme} back title="Changes to review">
      <p className="muted-p">Plico never overwrites someone else’s change without asking. Pick which version to keep.</p>
      <ol className="issues">{all.map(i => <li key={i.id}><IssueCard s={s} it={i} /></li>)}</ol>
    </Screen>
  )
}

function IssueCard({ s, it }: { s: State; it: Issue }) {
  const g = s.groups.find(x => x.id === it.gid)
  const name = namer(g)
  if (it.kind === 'failed') return (
    <div className="issue">
      <p className="issue-head"><strong>{it.title}</strong><small>Couldn’t be saved · {when(it.at)}</small></p>
      <p className="muted-p">{it.message}</p>
      <div className="row">
        <button className="btn secondary" onClick={() => resolveIssue(it.id, 'retry')}>Try again</button>
        <button className="btn secondary" onClick={() => resolveIssue(it.id, 'discard')}>Discard</button>
      </div>
    </div>
  )
  const mine = it.op.m === 'DELETE' || !it.op.body ? null : bodySnap(it.op.body as Parameters<typeof bodySnap>[0])
  const theirs = it.theirs && !it.theirs.deletedAt ? it.theirs : null
  const by = it.by ?? 'Someone'
  const head = !mine ? `You deleted this, but ${by} changed it first.`
    : !theirs ? `${by} deleted this while you were changing it.`
      : `${by} changed this while you were offline.`
  return (
    <div className="issue">
      <p className="issue-head"><strong>{mine?.title ?? theirs?.title ?? it.title}</strong><small>{head}{it.theirs?.updatedAt && ` ${cap(when(it.theirs.updatedAt))}.`}</small></p>
      {mine && theirs ? <Compare mine={mine} theirs={theirs} name={name} />
        : <p className="muted-p">{mine ? <>Yours: {summary(mine, name)}</> : theirs && <>Theirs: {summary(theirs, name)}</>}</p>}
      <div className="row">
        <button className="btn primary" onClick={() => resolveIssue(it.id, 'mine')}>{!mine ? 'Delete it anyway' : !theirs ? 'Put it back with my changes' : 'Keep mine'}</button>
        <button className="btn secondary" onClick={() => resolveIssue(it.id, 'theirs')}>{!mine ? 'Keep their version' : !theirs ? 'Leave it deleted' : 'Keep theirs'}</button>
      </div>
    </div>
  )
}

function Compare({ mine, theirs, name }: { mine: Snap; theirs: Snap; name: (id: Id) => string }) {
  const payers = (x: Snap) => x.shares.filter(y => y.paid).map(y => name(y.memberId)).join(', ')
  const split = (x: Snap) => x.shares.filter(y => y.owed).map(y => `${name(y.memberId)} ${inr(y.owed)}`).sort().join(', ')
  const rows = ([['Name', x => x.title], ['Amount', x => inr(x.amount)], ['Date', x => x.date], ['Category', x => x.cat], ['Paid by', payers], ['Split', split]] as [string, (x: Snap) => string][])
    .map(([label, f]) => [label, f(mine), f(theirs)]).filter(([, a, b]) => a !== b)
  return (
    <table className="cmp">
      <thead><tr><th scope="col"><span className="sr-only">Field</span></th><th scope="col">Yours</th><th scope="col">Theirs</th></tr></thead>
      <tbody>{rows.map(([l, a, b]) => <tr key={l}><th scope="row">{l}</th><td>{cap(a)}</td><td>{cap(b)}</td></tr>)}</tbody>
    </table>
  )
}

// ---------- the money audit ----------
type Event = AuditEvent
/** An audit entry's before/after as an expense, when it is one (checked, not assumed). */
const snapOf = (x: Event['before']) => (x ? SnapFull.safeParse(x).data ?? null : null)
const actionOf = (e: Event) => e.kind.split('.')[1]
function useFetch<T>(path: string, schema: z.ZodMiniType<T>, dep: unknown = null) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api<unknown>(path).then(r => setData(schema.parse(r)), () => setErr(navigator.onLine ? 'Couldn’t load this. Try again.' : 'History needs a connection. Come back online to see it.')) }, [path, dep])
  return { data, err }
}
const signed = (n: number) => `${n > 0 ? '+' : '−'}${inr(n)}`
const FIELD: Record<string, string> = { name: 'name', upi: 'UPI ID', email: 'email', phone: 'phone', kind: 'type', theme: 'theme', emoji: 'emoji', cover: 'cover photo', track: 'tracking only' }
const show = (k: string, v: unknown) => (v === null || v === '' ? 'none' : k === 'theme' ? theme(v as ThemeId).name : k === 'track' ? (v ? 'on' : 'off') : k === 'cover' ? 'a photo' : String(v))

/** One entry in words: the headline, what changed, and who it moved money for. Used on screen and in the CSV. */
function describe(e: Event, g: Group | undefined, meId?: string) {
  const name = namer(g)
  const actor = e.byId && e.byId === meId ? 'You' : e.byName
  const [area, a] = e.kind.split('.')
  let line: string, details: string[] = []
  if (area === 'expense') {
    const before = snapOf(e.before), after = snapOf(e.after), snap = after ?? before
    const verb = a === 'reverted' && e.revertOf ? `put back version ${e.revertOf} of` : ({ created: 'added', edited: 'changed', deleted: 'deleted', restored: 'restored' } as Record<string, string>)[a] ?? a
    line = `${actor} ${verb} “${snap?.title ?? 'an expense'}”`
    details = (a === 'edited' || a === 'reverted') && before && after ? changes(before, after, name) : snap ? [summary(snap, name)] : []
  } else if (area === 'member') {
    const who = String((e.after ?? e.before)?.name ?? (e.memberId ? name(e.memberId) : 'someone'))
    const email = (e.after ?? e.before)?.email ? ` (${(e.after ?? e.before)!.email})` : ''
    line = a === 'invited' ? `${actor} invited ${who}${email}` : a === 'joined' ? `${actor} joined${who !== actor && who !== 'you' ? ` as ${who}` : ''}`
      : a === 'removed' ? `${actor} removed ${who}${email}` : `${actor} changed ${e.memberId === g?.selfId && actor === 'You' ? 'your' : `${e.memberId ? name(e.memberId) : who}’s`} details`
    if (a === 'edited' && e.before && e.after) details = Object.keys(e.after).map(k => `${FIELD[k] ?? k}: ${show(k, e.before![k])} → ${show(k, e.after![k])}`)
  } else {
    line = a === 'created' ? (e.after?.kind === 'direct' ? `${actor} started keeping track together` : `${actor} created the group`) : `${actor} changed the group`
    if (a === 'edited' && e.before && e.after) details = Object.keys(e.after).map(k => `${FIELD[k] ?? k}: ${show(k, e.before![k])} → ${show(k, e.after![k])}`)
  }
  const moves = Object.entries(e.effect ?? {}).map(([id, n]) => `${cap(name(id))} ${signed(n)}`)
  return { line, details, moves }
}

async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
/** Re-check the whole chain on this phone: each entry links to the one before and matches its own hash. */
async function verify(events: Event[], head: { auditSeq: number; auditHash: string }) {
  let prev = GENESIS
  for (const [i, e] of events.entries()) {
    if (e.seq !== i + 1 || e.prevHash !== prev) return { ok: false, at: e.seq }
    const h = await sha256(prev + auditPayload({ ...e, at: new Date(e.at).toISOString() }))
    if (h !== e.hash) return { ok: false, at: e.seq }
    prev = h
  }
  return prev === head.auditHash && events.length === head.auditSeq ? { ok: true, at: 0 } : { ok: false, at: events.length + 1 }
}

function saveCsv(file: string, rows: (string | number)[][]) {
  const cell = (c: string | number) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))
  const blob = new Blob(['\ufeff' + rows.map(r => r.map(cell).join(',')).join('\n')], { type: 'text/csv' })
  const f = new File([blob], file, { type: 'text/csv' })
  // Phones: the share sheet (save to Files, send to yourself). Web: a download.
  if (Capacitor.isNativePlatform() && navigator.canShare?.({ files: [f] })) return void navigator.share({ files: [f], title: file }).catch(() => {})
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = file; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
const stamp = (at: string) => new Date(at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
const rupees = (n: number) => (n / 100).toFixed(2)

function Entry({ s, g, e, onRestore, busy, mine, label }: { s: State; g?: Group; e: Event; onRestore?: () => void; busy?: boolean; mine?: string; label?: string }) {
  const d = describe(e, g, s.user?.id)
  const go2 = e.expenseId && g ? () => go(`/g/${g.id}/e/${e.expenseId}/history`) : undefined
  return (
    <li>
      <Avatar name={e.byName} size={32} />
      <button className="feed-body" onClick={go2} disabled={!go2}>
        {label && <small className="log-group">{label}</small>}
        <p><strong>{d.line}</strong></p>
        {d.details.length > 0 && <ul className="changes">{d.details.map(w => <li key={w}>{cap(w)}</li>)}</ul>}
        {!mine && d.moves.length > 0 && <p className="moves">{d.moves.join(' · ')}</p>}
        <small>#{e.seq} · {cap(when(e.at))}</small>
      </button>
      {mine && e.effect[mine] ? <span className={`money ${e.effect[mine] > 0 ? 'pos' : 'neg'}`}>{signed(e.effect[mine])}</span>
        : onRestore && <button className="btn-sm" disabled={busy} onClick={onRestore}>{busy ? '…' : 'Restore'}</button>}
    </li>
  )
}

export function AuditLog({ s, g }: { s: State; g: Group }) {
  const [log, setLog] = useState<z.infer<typeof AuditOut> | null>(null)
  const [check, setCheck] = useState<{ ok: boolean; at: number } | null>(null)
  const [err, setErr] = useState('')
  const [shown, setShown] = useState(50)
  const [busy, setBusy] = useState('')
  const load = () => api<unknown>(`/api/groups/${g.id}/audit`).then(r => AuditOut.parse(r))
    .then(l => { setLog(l); setCheck(null); void verify(l.events, l.head).then(setCheck) },
      () => setErr(navigator.onLine ? 'Couldn’t load the audit log. Try again.' : 'The audit log needs a connection. Come back online to see it.'))
  useEffect(() => { void load() }, [g.id, g.expenses.length])
  const live = new Set(g.expenses.map(e => e.id))
  const lastOf = new Map((log?.events ?? []).filter(e => e.expenseId).map(e => [e.expenseId!, e.seq]))
  const restore = async (eid: string) => {
    setBusy(eid)
    await restoreExpense(g.id, eid).catch(e => setErr((e as Error).message))
    setBusy(''); void load()
  }
  const csv = () => log && saveCsv(`plico-${groupTitle(g).replace(/\W+/g, '-').toLowerCase()}-audit.csv`, [
    ['#', 'When', 'Who', 'What', 'Details', ...g.members.map(m => `${m.id === 'me' ? s.me.name || 'You' : m.name} (₹)`), 'Hash'],
    ...log.events.map(e => {
      const d = describe(e, g, s.user?.id)
      const idOf = (m: Group['members'][number]) => (m.id === 'me' ? g.selfId! : m.id)
      return [e.seq, stamp(e.at), e.byName, d.line, d.details.join('; '), ...g.members.map(m => (e.effect[idOf(m)] ? rupees(e.effect[idOf(m)]) : '')), e.hash]
    }),
  ])
  const events = [...(log?.events ?? [])].reverse()
  return (
    <Screen t={s.theme} back title="Audit log">
      {check && (check.ok
        ? <p className="verified"><Icon n="shield" size={20} /><span><strong>Verified: {count(log!.events.length, 'entry', 'entries')}, unbroken</strong><small>Checked on this phone. Every entry is sealed to the one before it, so no past record can be changed or removed without it showing here.</small></span></p>
        : <p className="error" role="alert">Entry #{check.at} doesn’t match its seal. The log may have been altered after it was written. Please report this to privacy@plico.space.</p>)}
      {err && <p className="error" role="alert">{err}</p>}
      {!err && !log && <p className="muted-p">Loading…</p>}
      {log && <div className="row"><button className="btn secondary" onClick={csv}><Icon n="copy" size={18} />Export CSV</button></div>}
      <ol className="feed">
        {events.slice(0, shown).map(e => (
          <Entry key={e.seq} s={s} g={g} e={e} busy={busy === e.expenseId}
            onRestore={e.kind === 'expense.deleted' && !live.has(e.expenseId!) && lastOf.get(e.expenseId!) === e.seq ? () => void restore(e.expenseId!) : undefined} />
        ))}
      </ol>
      {events.length > shown && <button className="btn secondary" onClick={() => setShown(shown + 50)}>Show older</button>}
    </Screen>
  )
}

// ---------- Activity: everything in my groups, or just what moved my balance ----------
type Mine = ActivityEvent
export function Activity({ s }: { s: State }) {
  const [scope, setScope] = useState<'all' | 'money'>('all')
  const [rows, setRows] = useState<Mine[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [loaded, setLoaded] = useState(false)
  const load = (before?: string) => api<unknown>(`/api/me/activity?scope=${scope}${before ? `&before=${encodeURIComponent(before)}` : ''}`).then(r => ActivityOut.parse(r))
    .then(r => {
      setRows(x => (before ? [...x, ...r.events] : r.events)); setNext(r.next); setLoaded(true); setErr('')
      if (!before && r.events[0]) void seenActivity(r.events[0].at)
    }, () => setErr(navigator.onLine ? 'Couldn’t load activity. Try again.' : 'Activity needs a connection. Come back online to see it.'))
  useEffect(() => { setLoaded(false); void load() }, [scope])
  const total = s.groups.reduce((a, g) => a + (balances(g)[ME] ?? 0), 0)
  const gOf = (id: string) => s.groups.find(g => g.id === id)
  const title = (e: Mine) => (gOf(e.groupId) ? groupTitle(gOf(e.groupId)!) : e.group.name)
  const csv = () => saveCsv(`plico-activity-${scope}.csv`, [
    ['When', 'Group', 'Who', 'What', 'Details', 'My balance change (₹)', 'Group entry #', 'Hash'],
    ...rows.map(e => { const d = describe(e, gOf(e.groupId), s.user?.id); return [stamp(e.at), title(e), e.byName, d.line, d.details.join('; '), e.myEffect ? rupees(e.myEffect) : '', e.seq, e.hash] }),
  ])
  return (
    <Screen t={s.theme} fab="/add" title="Activity">
      {scope === 'money' && <Denomination t={s.theme} amount={total} line={total > 0 ? 'You’re owed overall' : total < 0 ? 'You owe overall' : 'All even'} caption="Every change to your balance, newest first" />}
      <div className="seg activity-seg" role="tablist" aria-label="Show">
        <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>Everything</button>
        <button role="tab" aria-selected={scope === 'money'} className={scope === 'money' ? 'on' : ''} onClick={() => setScope('money')}>My money</button>
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {!loaded && !err && <ol className="feed" aria-busy="true">{[0, 1, 2].map(i => <li key={i} className="skeleton" aria-hidden />)}</ol>}
      {loaded && !rows.length && (
        <div className="empty-state"><Plico mood="empty" size={72} /><p><strong>Quiet so far.</strong>{scope === 'all' ? ' Everything people add, change or settle in your groups shows up here, with who did it.' : ' Expenses and settlements that change your balance show up here.'}</p></div>
      )}
      <ol className="feed">
        {rows.map(e => <Entry key={e.groupId + e.seq} s={s} g={gOf(e.groupId)} e={e} mine={scope === 'money' || e.myEffect ? e.memberOf : undefined} label={title(e)} />)}
      </ol>
      {next && <button className="btn secondary" onClick={() => void load(next)}>Show older</button>}
      {rows.length > 0 && <button className="link center-link" onClick={csv}><Icon n="copy" size={18} />Export as CSV</button>}
    </Screen>
  )
}

// ---------- one expense, every version ----------
export function ExpenseHistory({ s, g, eid }: { s: State; g: Group; eid: Id }) {
  const local = g.expenses.find(e => e.id === eid)
  const { data, err } = useFetch(`/api/groups/${g.id}/expenses/${eid}/history`, z.array(AuditEvent), local?.v)
  const [busy, setBusy] = useState(0)
  const [note, setNote] = useState('')
  const latest = data?.at(-1)
  const deleted = latest ? actionOf(latest) === 'deleted' : false
  const title = (snapOf(latest?.after ?? null) ?? snapOf(latest?.before ?? null))?.title ?? local?.title ?? 'Expense'
  const act = async (v: number, fn: () => Promise<void>) => {
    setBusy(v); setNote('')
    await fn().then(() => setNote('Done. Everyone in the group sees it on their next sync.'),
      e => setNote(/changed this first/i.test((e as Error).message) ? 'Someone changed it a moment ago. Look again and retry.' : (e as Error).message))
    setBusy(0)
  }
  return (
    <Screen t={s.theme} back title="History">
      <h2 className="hist-title">{title}</h2>
      {deleted && <p className="muted-p">Deleted by {latest!.byId === s.user?.id ? 'you' : latest!.byName}, {when(latest!.at)}.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {note && <p className="notice" role="status">{note}</p>}
      {deleted && <button className="btn primary" disabled={!!busy} onClick={() => void act(latest!.version ?? 0, () => restoreExpense(g.id, eid))}>Restore this expense</button>}
      <ol className="versions">
        {[...(data ?? [])].reverse().map(e => {
          const current = e === latest && !deleted
          return (
            <li key={e.seq} className={current ? 'current' : ''}>
              <p className="ver-head"><span className="ver-n">v{e.version}</span><small>{cap(when(e.at))}</small>{current && <span className="tag">Current</span>}</p>
              <VersionLine s={s} g={g} e={e} />
              {!current && !deleted && snapOf(e.after) && latest && (
                <button className="link" disabled={!!busy} onClick={() => void act(e.version ?? 0, () => revertExpense(g.id, eid, snapOf(e.after)!, e.version ?? 0, latest.version ?? 0))}>
                  <Icon n="back" size={16} />{busy === e.version ? 'Restoring…' : 'Restore this version'}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </Screen>
  )
}
