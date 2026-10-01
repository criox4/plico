// Ask Plico: the floating button and the chat. Answers stream from /api/chat; actions arrive as cards that do
// nothing until tapped, and then go through the app's normal paths (the outbox, Settle, Remind).
// A receipt can ride along with a message; itemized cards let you fix who had what before adding.
// History stays on this device (per account) and is cleared on sign-out; photos are never kept in it.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, useDragControls, type PanInfo } from 'motion/react'
import { SPRING } from './anim'
import * as M from 'motion/react-m'
import { ME, inr, itemSplit, needsConfirm, today, uid } from './logic'
import { update, useStore } from './store'
import { ChatCard, ChatEvent } from './schema'
import { NET, api, markAi, photoData, request, restoreExpense } from './sync'
import { commitDraft, fromCard, type Saved } from './draft'
import { Icon } from './icons'
import { Plico, go } from './ui'

type Card = ChatCard & { done?: string; err?: string }
type Msg = { role: 'user' | 'assistant'; content: string; cards?: Card[]; declined?: boolean; error?: boolean; photo?: boolean }
export const CHAT_KEY = 'plico-chat:'
// Cards saved by an older version of the app are dropped rather than shown half-understood.
const load = (k: string): Msg[] => {
  try { return (JSON.parse(localStorage.getItem(k) ?? '[]') as Msg[]).map(m => ({ ...m, cards: m.cards?.filter(c => ChatCard.safeParse(c).success) })) } catch { return [] }
}
const save = (k: string, m: Msg[]) => { try { localStorage.setItem(k, JSON.stringify(m.slice(-40))) } catch { /* full: history is a convenience */ } }

const DOING: Record<string, string> = {
  read_receipt: 'Reading the bill…', list_groups: 'Looking at your groups…', balances: 'Checking balances…', find_expenses: 'Searching expenses…', spending: 'Adding up spending…',
  activity: 'Reading recent activity…', draft_expense: 'Working out the split…', draft_settlement: 'Working out the settle-up…', draft_reminder: 'Preparing a reminder…',
  explain_balance: 'Tracing the balance…', pending: 'Checking payments…', confirm_payment: 'Finding the payment…', mark_paid: 'Preparing the payment…',
  edit_expense: 'Preparing the change…', delete_expense: 'Preparing to delete…', restore_expense: 'Finding what was deleted…',
}
const ASK = ['Who owes me the most?', 'How much did I spend on food this month?', 'What changed in my groups this week?', 'Settle up with someone']
export const ASK_ADD = ['Auto ₹250 with Bala', 'Dinner ₹3,200 in Goa, Karan paid', 'Attach a bill, then say who had what']
const key = (s: ReturnType<typeof useStore>) => (s.user ? `${CHAT_KEY}${s.user.id}` : '')

/** Phones get a bottom sheet you can drag down to close; wide screens a side panel. */
const phone = () => !matchMedia('(min-width: 900px)').matches

export function ChatButton() {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const drag = useDragControls()
  const sheet = phone()
  const close = () => { setOpen(false); btn.current?.focus() }
  // Released after a real pull or a quick flick: close; otherwise the sheet springs back.
  const release = (_: PointerEvent, i: PanInfo) => { if (i.offset.y > 120 || i.velocity.y > 600) close() }
  return <>
    <button ref={btn} className="chat-fab" aria-label="Ask Plico" aria-expanded={open} onClick={() => setOpen(true)}><Plico mood="idle" size={34} /></button>
    <AnimatePresence>
      {open && (
        <M.div key="chat" className="chat-scrim" onClick={e => { if (e.target === e.currentTarget) close() }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
          <M.section className="chat" role="dialog" aria-modal="true" aria-labelledby="chat-title"
            initial={sheet ? { y: '100%' } : { x: 32, opacity: 0 }} animate={sheet ? { y: 0 } : { x: 0, opacity: 1 }} exit={sheet ? { y: '100%' } : { x: 32, opacity: 0 }} transition={SPRING}
            drag={sheet ? 'y' : false} dragControls={drag} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: 0.9 }} onDragEnd={release}>
            <Chat onClose={close} onGrab={sheet ? e => { if (!(e.target as HTMLElement).closest('button')) drag.start(e) } : undefined} />
          </M.section>
        </M.div>
      )}
    </AnimatePresence>
  </>
}

/** The conversation. `onClose` shows the header (the floating chat); `onSaved` is where the Add screen goes after an expense lands. */
export function Chat({ onClose, onSaved, onGrab, suggestions = ASK, hint = 'Ask about your balances, spending…' }: {
  onClose?: () => void; onSaved?: (s: Saved[]) => void; onGrab?: (e: React.PointerEvent) => void; suggestions?: string[]; hint?: string
}) {
  const s = useStore()
  const k = key(s) + (onSaved ? ':add' : '')
  const [msgs, setMsgs] = useState<Msg[]>(() => load(k))
  const seen = useRef(msgs.length) // saved history appears at once; only new messages animate in
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('') // what the assistant is doing right now
  const [photo, setPhoto] = useState<{ url: string; data: string } | null>(null) // attached to the next message
  const lastPhoto = useRef<string | null>(null) // the bill being discussed, re-sent with follow-ups (the server caches its reading)
  const input = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { save(k, msgs); end.current?.scrollIntoView({ block: 'end' }) }, [msgs, k])
  useEffect(() => {
    if (!onClose) return
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', esc); return () => removeEventListener('keydown', esc)
  }, [onClose])

  const attach = async (f: File) => {
    try { setPhoto({ url: URL.createObjectURL(f), data: await photoData(f) }) } catch (e) { setMsgs(m => [...m, { role: 'assistant', content: (e as Error).message, error: true }]) }
  }
  const ask = async (raw: string) => {
    const text = (raw.trim() || (photo ? 'Here’s the bill.' : '')).slice(0, 1000)
    if (!text || busy) return
    if (!navigator.onLine) return setMsgs(m => [...m, { role: 'user', content: text }, { role: 'assistant', content: 'I need a connection to answer. Everything else in Plico works offline, including Enter it.', error: true }])
    if (photo) lastPhoto.current = photo.data
    // A follow-up about a bill still waiting to be added carries the bill again.
    const open = msgs.some(m => m.cards?.some(c => c.type === 'expense' && c.items && !c.done))
    const image = photo?.data ?? (open ? lastPhoto.current : null)
    const history = [...msgs, { role: 'user' as const, content: text, ...(photo && { photo: true }) }]
    setMsgs([...history, { role: 'assistant', content: '' }]); setQ(''); setPhoto(null); setBusy(image ? 'Reading the bill…' : 'Thinking…')
    const patch = (f: (m: Msg) => Msg) => setMsgs(all => [...all.slice(0, -1), f(all[all.length - 1])])
    try {
      const res = await request('/api/chat', { method: 'POST', body: JSON.stringify({
        messages: history.filter(m => !m.error && m.content).slice(-20).map(m => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? 1000 : 4000) })),
        today: new Date().toLocaleDateString('en-CA'), ...(image && { image }),
      }) })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'I couldn’t answer that right now.')
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += value
        const parts = buf.split('\n\n'); buf = parts.pop() ?? ''
        for (const part of parts) for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue
          const r = ChatEvent.safeParse(JSON.parse(line.slice(5).trim()))
          if (!r.success) continue
          const e = r.data
          if (e.type === 'text') { setBusy(''); patch(m => ({ ...m, content: m.content + e.d })) }
          else if (e.type === 'tool') setBusy(DOING[e.name] ?? 'Working…')
          else if (e.type === 'card') patch(m => ({ ...m, cards: [...(m.cards ?? []), e.card] }))
          else if (e.type === 'declined') patch(m => ({ ...m, declined: true }))
          else if (e.type === 'error') patch(m => ({ ...m, content: m.content || e.message, error: !m.content }))
        }
      }
    } catch (x) {
      // A stream that drops partway fails while reading, with the browser's raw wording: say it plainly.
      const why = x instanceof TypeError ? NET : (x as Error).message
      patch(m => ({ ...m, content: m.content ? `${m.content}\n\n${why}` : why, error: !m.content }))
    } finally { setBusy('') }
  }

  const setCard = (mi: number, ci: number, p: Partial<Card>) =>
    setMsgs(all => all.map((m, i) => (i === mi ? { ...m, cards: m.cards?.map((c, j) => (j === ci ? { ...c, ...p } as Card : c)) } : m)))

  return <>
    {onClose && (
      <header className="chat-head" onPointerDown={onGrab} style={onGrab && { touchAction: 'none' }}>
        {onGrab && <span className="chat-grip" aria-hidden />}
        <Plico mood={busy ? 'thinking' : 'idle'} size={32} />
        <h2 id="chat-title">Ask Plico</h2>
        {msgs.length > 0 && <button className="iconbtn" aria-label="Clear this chat" onClick={() => setMsgs([])}><Icon n="trash" size={20} /></button>}
        <button className="iconbtn" aria-label="Close" onClick={onClose}><Icon n="close" /></button>
      </header>
    )}
    <div className="chat-log" role="log" aria-live="polite" aria-busy={!!busy}>
      {!msgs.length && (
        <div className="chat-empty">
          <p><strong>{onSaved ? 'Tell me what you spent.' : 'Ask about your groups and money.'}</strong>{onSaved
            ? 'Type it like you’d text a friend, or attach a bill and say who had what. I’ll work out the split for you to check.'
            : 'I can look things up, and get an expense, a settle-up or a reminder ready for you to confirm.'}</p>
          <ul>{suggestions.map(a => <li key={a}><button className="chip" onClick={() => (a.startsWith('Attach') ? document.getElementById('chat-photo')?.click() : void ask(a))}>{a}</button></li>)}</ul>
        </div>
      )}
      {msgs.map((m, i) => (
        <M.div key={i} className={`bubble ${m.role}${m.error ? ' err' : ''}`} initial={seen.current > i ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING}>
          {m.photo && <span className="bubble-photo"><Icon n="qr" size={14} />Bill attached</span>}
          {m.content ? <Rich text={m.content} /> : i === msgs.length - 1 && busy ? null : <p className="muted-ink">…</p>}
          {m.cards?.map((c, j) => <ActionCard key={j} c={c} set={p => setCard(i, j, p)} close={onClose} onSaved={onSaved} />)}
        </M.div>
      ))}
      {busy && <p className="chat-busy" role="status"><span className="dots" aria-hidden><i /><i /><i /></span>{busy}</p>}
      <div ref={end} />
    </div>
    <form className="chat-in" onSubmit={e => { e.preventDefault(); void ask(q) }}>
      {photo && (
        <div className="chat-attached">
          <img src={photo.url} alt="The bill you attached" />
          <button type="button" className="iconbtn" aria-label="Remove the bill" onClick={() => setPhoto(null)}><Icon n="close" size={18} /></button>
        </div>
      )}
      <label className="chat-clip iconbtn" aria-label="Attach a bill or screenshot" title="Attach a bill or screenshot">
        <input id="chat-photo" type="file" accept="image/*" className="sr-only" disabled={!!busy} onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void attach(f) }} />
        <Icon n="qr" size={22} />
      </label>
      <textarea ref={input} rows={1} value={q} maxLength={1000} placeholder={photo ? 'Who had what? e.g. non-veg with Bala' : hint} aria-label="Your message"
        onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(q) } }} />
      <button className="chat-send" disabled={(!q.trim() && !photo) || !!busy} aria-label="Send"><Icon n="send" size={20} /></button>
    </form>
    <p className="chat-fine">Answers come from your Plico data via AI and can be wrong. Nothing changes until you tap.</p>
  </>
}

/** Plain text with **bold** and "- " lists. Never HTML, never links: actions come only from cards. */
function Rich({ text }: { text: string }) {
  const inline = (t: string) => t.split(/(\*\*[^*]+\*\*)/g).map((p, i) => (p.startsWith('**') && p.endsWith('**') && p.length > 4 ? <strong key={i}>{p.slice(2, -2)}</strong> : p))
  const out: ReactNode[] = []
  let list: string[] = []
  const flush = () => { if (list.length) out.push(<ul key={out.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>); list = [] }
  for (const line of text.split('\n')) {
    if (/^\s*[-•*]\s+/.test(line)) { list.push(line.replace(/^\s*[-•*]\s+/, '')); continue }
    flush()
    if (line.trim()) out.push(<p key={out.length}>{inline(line.replace(/^#+\s*/, ''))}</p>)
  }
  flush()
  return <>{out}</>
}

function ActionCard({ c, set, close, onSaved }: { c: Card; set: (p: Partial<Card>) => void; close?: () => void; onSaved?: (s: Saved[]) => void }) {
  if (c.type === 'expense') return <ExpenseCard c={c} set={set} close={close} onSaved={onSaved} />
  return <SimpleCard c={c} set={set} close={close} />
}

/** A drafted expense: who it's with, who paid, each person's share; with a bill, every item and who had it, tap to change. */
function ExpenseCard({ c, set, close, onSaved }: { c: Extract<Card, { type: 'expense' }>; set: (p: Partial<Card>) => void; close?: () => void; onSaved?: (s: Saved[]) => void }) {
  const [busy, setBusy] = useState(false)
  const payer = Object.keys(c.paid)[0]
  const people = Object.keys(c.names)
  const res = c.items ? itemSplit(c.items, c.extras ?? 0) : { owed: c.owed }
  const owed = 'owed' in res ? res.owed : c.owed
  const amount = Object.values(owed).reduce((a, b) => a + b, 0)
  const where = c.target.kind === 'group' ? c.target.group : `With ${c.target.people.map(p => p.name).join(', ')}`
  const toggle = (i: number, k: string) => set({ items: c.items!.map((it, j) => (j !== i ? it : { ...it, who: it.who.includes(k) ? it.who.filter(x => x !== k) : [...it.who, k], unsure: false })) })
  const add = async () => {
    if ('error' in res) return set({ err: res.error })
    const d = fromCard({ ...c, amount, owed, paid: { [payer]: amount } })
    if ('error' in d) return set({ err: d.error })
    setBusy(true)
    try { const saved = await commitDraft(d, 'ai'); set({ done: 'Added', err: undefined }); onSaved?.(saved) }
    catch (e) { set({ err: (e as Error).message }) } finally { setBusy(false) }
  }
  const open = () => { close?.(); go(c.target.kind === 'group' ? `/g/${c.target.groupId}` : c.target.people.length === 1 ? `/f/${encodeURIComponent(c.target.people[0].email)}` : '/friends') }
  const unsure = c.items?.filter(i => i.unsure).length ?? 0
  return (
    <div className="xcard">
      <p className="xcard-where">{c.target.kind === 'group' ? <Icon n="friends" size={16} /> : <Icon n="direct" size={16} />}{where}{c.target.kind === 'friends' && <small> · no group</small>}</p>
      <p className="xcard-title"><strong>{c.title}</strong><span className="money">{inr(amount)}</span></p>
      <p className="xcard-paid">Paid by {c.names[payer] ?? 'you'}{c.items ? ` · by item${c.extras ? `, ${c.extras > 0 ? 'taxes and tips' : 'discounts'} ${inr(Math.abs(c.extras))} shared by what each had` : ''}` : ' · split equally'}</p>
      {c.items && (
        <ol className="xitems" aria-label="Who had what">
          {c.items.map((it, i) => (
            <li key={i} className={it.unsure ? 'unsure' : ''}>
              <span className="xitem-name">{it.name}{it.unsure && <small>Check who had this</small>}</span>
              <span className="money">{inr(it.amount)}</span>
              <span className="xitem-who">{people.map(k => (
                <button type="button" key={k} disabled={!!c.done} className={`who-chip${it.who.includes(k) ? ' on' : ''}`} aria-pressed={it.who.includes(k)} aria-label={`${c.names[k]} had ${it.name}`} onClick={() => toggle(i, k)}>{c.names[k]}</button>
              ))}</span>
            </li>
          ))}
        </ol>
      )}
      <ul className="xshares" aria-label="Each person’s share">
        {Object.entries(owed).filter(([, v]) => v).map(([k, v]) => <li key={k}><span>{c.names[k] ?? k}</span><span className="money">{inr(v)}</span></li>)}
      </ul>
      {c.done ? <p className="action-done"><Icon n="check" size={16} />{c.done}<button className="link" onClick={open}>Open {c.target.kind === 'group' ? c.target.group : 'it'}</button></p>
        : <button className="btn-sm" disabled={busy || 'error' in res} onClick={() => void add()}>{busy ? 'Adding…' : unsure ? `Add ${inr(amount)} anyway` : `Add ${inr(amount)}`}</button>}
      {('error' in res || c.err) && <p className="error" role="alert">{'error' in res ? res.error : c.err}</p>}
    </div>
  )
}

/** Every other card: one sentence, one button. Writes go through the app's normal paths (the outbox, restore, Remind),
 *  so the server checks them like any tap in the app; the ones that change the ledger are marked as made via Ask Plico. */
function SimpleCard({ c, set, close }: { c: Exclude<Card, { type: 'expense' }>; set: (p: Partial<Card>) => void; close?: () => void }) {
  const s = useStore()
  const [busy, setBusy] = useState(false)
  const g = s.groups.find(x => x.id === c.groupId)
  const local = (id: string) => (id === g?.selfId ? ME : id)
  const mine = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [local(k), v]))
  const find = (eid: string) => g?.expenses.find(x => x.id === eid)
  const changed = 'That changed since I drafted this. Ask me again.'
  const act = async (yes = true) => {
    if (!g) return set({ err: 'That group isn’t on this phone yet. Give it a moment to sync, then ask again.' })
    setBusy(true)
    try {
      if (c.type === 'settle') {
        if (![c.from, c.to].every(id => g.members.some(m => m.id === local(id)))) return set({ err: 'People in that group changed. Ask again.' })
        close?.(); go(`/g/${g.id}/pay/${local(c.from)}/${local(c.to)}/${c.amount}`)
      } else if (c.type === 'remind') {
        await api(`/api/groups/${g.id}/remind`, { method: 'POST', body: JSON.stringify({ memberId: c.memberId, amount: c.amount }) }); set({ done: 'Reminder sent' })
      } else if (c.type === 'pay') {
        const [from, to] = [local(c.from), local(c.to)]
        if (![from, to].every(id => g.members.some(m => m.id === id))) return set({ err: 'People in that group changed. Ask again.' })
        const id = uid(); markAi(id)
        update(d => { d.groups.find(x => x.id === g.id)?.expenses.push({ id, title: 'Settlement', cat: 'check', date: today(), amount: c.amount, paid: { [from]: c.amount }, owed: { [to]: c.amount }, settle: true, ...(needsConfirm(g, to) && { pending: true }) }) })
        set({ done: c.confirm ? 'Recorded, and it counts. Add proof from the payment’s details if you like.' : 'Recorded' })
      } else if (c.type === 'confirm') {
        if (!find(c.expenseId)?.pending) return set({ err: 'That payment’s already been checked.' })
        markAi(c.expenseId)
        update(d => { const e = d.groups.find(x => x.id === g.id)?.expenses.find(x => x.id === c.expenseId); if (e) { delete e.pending; if (!yes) e.rejected = true } })
        set({ done: yes ? 'Confirmed' : 'Marked as not arrived' })
      } else if (c.type === 'edit') {
        const e = find(c.expenseId)
        if (!e || e.v !== c.version) return set({ err: changed })
        const shares = JSON.stringify([c.before.paid, c.before.owed]) !== JSON.stringify([c.after.paid, c.after.owed])
        markAi(c.expenseId)
        update(d => {
          const x = d.groups.find(y => y.id === g.id)?.expenses.find(y => y.id === c.expenseId)
          if (!x) return
          Object.assign(x, { title: c.after.title, cat: c.after.cat, date: c.after.date, amount: c.after.amount })
          if (shares) Object.assign(x, { paid: mine(c.after.paid), owed: mine(c.after.owed), mode: 'exact', input: Object.fromEntries(Object.entries(mine(c.after.owed)).map(([k, v]) => [k, v / 100])) })
        })
        set({ done: 'Saved' })
      } else if (c.type === 'delete') {
        const e = find(c.expenseId)
        if (!e || e.v !== c.version) return set({ err: changed })
        markAi(c.expenseId)
        update(d => { const x = d.groups.find(y => y.id === g.id); if (x) x.expenses = x.expenses.filter(y => y.id !== c.expenseId) })
        set({ done: 'Deleted. Ask me to bring it back any time.' })
      } else {
        await restoreExpense(g.id, c.expenseId, 'ai'); set({ done: 'Restored' })
      }
    } catch (e) { set({ err: (e as Error).message }) } finally { setBusy(false) }
  }
  const icon = c.type === 'remind' ? 'bell' : c.type === 'delete' ? 'trash' : c.type === 'edit' || c.type === 'restore' ? 'log' : 'cash'
  const label = { settle: 'Open settle up', remind: 'Send reminder', pay: 'Record payment', confirm: 'Got it', edit: 'Save changes', delete: 'Delete', restore: 'Restore' }[c.type]
  return (
    <div className={`action-card${c.type === 'delete' ? ' danger' : ''}`}>
      <p><Icon n={icon} size={18} /><span>{c.type === 'edit' ? <>Change “{c.before.title}” in {c.group}</> : c.summary}</span></p>
      {c.type === 'edit' && <ul className="xchanges">{c.changes.map(x => <li key={x}>{x}</li>)}</ul>}
      {c.done ? <p className="action-done"><Icon n="check" size={16} />{c.done}</p>
        : <span className="action-row">
            <button className="btn-sm" disabled={busy} onClick={() => void act()}>{label}</button>
            {c.type === 'confirm' && <button className="btn-sm ghost" disabled={busy} onClick={() => void act(false)}>Not yet</button>}
          </span>}
      {c.err && <p className="error" role="alert">{c.err}</p>}
    </div>
  )
}
