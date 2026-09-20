// Sync issues (conflicts, refused changes), the group activity feed and one expense's history.
import { useEffect, useState } from 'react'
import { changes, inr, summary, type Group, type Id, type Snap } from './logic'
import type { State } from './store'
import { api, bodySnap, resolveIssue, restoreExpense, revertExpense, useSync, type Issue, type ServerExpense } from './sync'
import { Avatar, Screen, count, go } from './ui'
import { Icon } from './icons'

const when = (at: string) => {
  const d = new Date(at)
  const t = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? `today, ${t}` : `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${t}`
}
/** Server member id → a name in sentences ("paid by you"). */
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

// ---------- activity feed ----------
type Event = { id: string; expenseId: string; version: number; action: string; revertOf: number | null; byId: string | null; byName: string; at: string
  before: (Snap & Partial<ServerExpense>) | null; after: (Snap & Partial<ServerExpense>) | null }
const VERB: Record<string, string> = { created: 'added', edited: 'changed', deleted: 'deleted', restored: 'restored', reverted: 'put back an older version of' }

function useFetch<T>(path: string, dep: unknown = null) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => { api<T>(path).then(setData, () => setErr(navigator.onLine ? 'Couldn’t load this. Try again.' : 'History needs a connection. Come back online to see it.')) }, [path, dep])
  return { data, err, setData }
}

function EventLine({ s, g, e, detail = true }: { s: State; g: Group; e: Event; detail?: boolean }) {
  const name = namer(g)
  const actor = e.byId && e.byId === s.user?.id ? 'You' : e.byName
  const snap = e.after ?? e.before
  const what = e.action === 'edited' || e.action === 'reverted' ? (e.before && e.after ? changes(e.before, e.after, name) : [])
    : snap ? [summary(snap, name)] : []
  return <>
    <p><strong>{actor}</strong> {e.action === 'reverted' && e.revertOf ? `put back version ${e.revertOf} of` : VERB[e.action] ?? e.action} {detail && <strong>{snap?.title}</strong>}</p>
    {what.length > 0 && <ul className="changes">{what.map(w => <li key={w}>{cap(w)}</li>)}</ul>}
  </>
}

export function Activity({ s, g }: { s: State; g: Group }) {
  const [pages, setPages] = useState<Event[][]>([])
  const [err, setErr] = useState('')
  const [end, setEnd] = useState(false)
  const load = (before?: string) => api<Event[]>(`/api/groups/${g.id}/activity${before ? `?before=${encodeURIComponent(before)}` : ''}`)
    .then(p => { setPages(x => (before ? [...x, p] : [p])); setEnd(p.length < 40) },
      () => setErr(navigator.onLine ? 'Couldn’t load activity. Try again.' : 'Activity needs a connection. Come back online to see it.'))
  useEffect(() => { void load() }, [g.id, g.expenses.length])
  const events = pages.flat()
  const live = new Set(g.expenses.map(e => e.id))
  const [busy, setBusy] = useState('')
  const restore = async (eid: string) => {
    setBusy(eid)
    await restoreExpense(g.id, eid).catch(e => setErr((e as Error).message))
    setBusy(''); void load()
  }
  return (
    <Screen t={g.theme} back title="Activity">
      {err && <p className="error" role="alert">{err}</p>}
      {!err && !pages.length && <p className="muted-p">Loading…</p>}
      {pages.length > 0 && !events.length && <p className="muted-p">Nothing yet. Every expense added, changed or deleted in {g.name} shows up here, with who did it.</p>}
      <ol className="feed">
        {events.map(e => {
          const gone = e.action === 'deleted' && !live.has(e.expenseId)
          return (
            <li key={e.id}>
              <Avatar name={e.byName} size={32} />
              <button className="feed-body" onClick={() => go(`/g/${g.id}/e/${e.expenseId}/history`)} aria-label={`History of ${(e.after ?? e.before)?.title}`}>
                <EventLine s={s} g={g} e={e} />
                <small>{cap(when(e.at))}</small>
              </button>
              {gone && <button className="btn-sm" disabled={!!busy} onClick={() => void restore(e.expenseId)}>{busy === e.expenseId ? '…' : 'Restore'}</button>}
            </li>
          )
        })}
      </ol>
      {events.length > 0 && !end && <button className="btn secondary" onClick={() => void load(events.at(-1)!.at)}>Show older</button>}
    </Screen>
  )
}

// ---------- one expense, every version ----------
export function ExpenseHistory({ s, g, eid }: { s: State; g: Group; eid: Id }) {
  const local = g.expenses.find(e => e.id === eid)
  const { data, err } = useFetch<Event[]>(`/api/groups/${g.id}/expenses/${eid}/history`, local?.v)
  const [busy, setBusy] = useState(0)
  const [note, setNote] = useState('')
  const latest = data?.at(-1)
  const deleted = latest?.action === 'deleted'
  const title = (latest?.after ?? latest?.before)?.title ?? local?.title ?? 'Expense'
  const act = async (v: number, fn: () => Promise<void>) => {
    setBusy(v); setNote('')
    await fn().then(() => setNote('Done. Everyone in the group sees it on their next sync.'),
      e => setNote(/changed this first/i.test((e as Error).message) ? 'Someone changed it a moment ago. Look again and retry.' : (e as Error).message))
    setBusy(0)
  }
  return (
    <Screen t={g.theme} back title="History">
      <h2 className="hist-title">{title}</h2>
      {deleted && <p className="muted-p">Deleted by {latest!.byId === s.user?.id ? 'you' : latest!.byName}, {when(latest!.at)}.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {note && <p className="notice" role="status">{note}</p>}
      {deleted && <button className="btn primary" disabled={!!busy} onClick={() => void act(latest!.version, () => restoreExpense(g.id, eid))}>Restore this expense</button>}
      <ol className="versions">
        {[...(data ?? [])].reverse().map(e => {
          const current = e === latest && !deleted
          return (
            <li key={e.id} className={current ? 'current' : ''}>
              <p className="ver-head"><span className="ver-n">v{e.version}</span><small>{cap(when(e.at))}</small>{current && <span className="tag">Current</span>}</p>
              <EventLine s={s} g={g} e={e} detail={false} />
              {!current && !deleted && e.after && latest && (
                <button className="link" disabled={!!busy} onClick={() => void act(e.version, () => revertExpense(g.id, eid, e.after!, e.version, latest.version))}>
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
