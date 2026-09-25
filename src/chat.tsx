// Ask Plico: the floating button and the chat. Answers stream from /api/chat; actions arrive as cards that do
// nothing until tapped, and then go through the app's normal paths (the outbox, Settle, Remind).
// History stays on this device (per account) and is cleared on sign-out.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ME, inr, uid } from './logic'
import { update, useStore } from './store'
import { ChatEvent, type ChatCard } from './schema'
import { api, request } from './sync'
import { Icon } from './icons'
import { Plico, go } from './ui'

type Card = ChatCard & { done?: string; err?: string }
type Msg = { role: 'user' | 'assistant'; content: string; cards?: Card[]; declined?: boolean; error?: boolean }
export const CHAT_KEY = 'plico-chat:'
const load = (k: string): Msg[] => { try { return JSON.parse(localStorage.getItem(k) ?? '[]') } catch { return [] } }
const save = (k: string, m: Msg[]) => { try { localStorage.setItem(k, JSON.stringify(m.slice(-40))) } catch { /* full: history is a convenience */ } }

const DOING: Record<string, string> = {
  list_groups: 'Looking at your groups…', balances: 'Checking balances…', find_expenses: 'Searching expenses…', spending: 'Adding up spending…',
  activity: 'Reading recent activity…', draft_expense: 'Preparing the expense…', draft_settlement: 'Working out the settle-up…', draft_reminder: 'Preparing a reminder…',
}
const ASK = ['Who owes me the most?', 'How much did I spend on food this month?', 'What changed in my groups this week?', 'Settle up with someone']

export function ChatButton() {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  return <>
    <button ref={btn} className="chat-fab" aria-label="Ask Plico" aria-expanded={open} onClick={() => setOpen(true)}><Plico mood="idle" size={34} /></button>
    {open && <Chat onClose={() => { setOpen(false); btn.current?.focus() }} />}
  </>
}

function Chat({ onClose }: { onClose: () => void }) {
  const s = useStore()
  const key = CHAT_KEY + (s.user?.id ?? '')
  const [msgs, setMsgs] = useState<Msg[]>(() => load(key))
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState('') // what the assistant is doing right now
  const input = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  useEffect(() => { save(key, msgs); end.current?.scrollIntoView({ block: 'end' }) }, [msgs, key])
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    addEventListener('keydown', k); return () => removeEventListener('keydown', k)
  }, [onClose])

  const ask = async (text: string) => {
    text = text.trim().slice(0, 1000)
    if (!text || busy) return
    if (!navigator.onLine) return setMsgs(m => [...m, { role: 'user', content: text }, { role: 'assistant', content: 'I need a connection to answer. Everything else in Plico works offline.', error: true }])
    const history = [...msgs, { role: 'user' as const, content: text }]
    setMsgs([...history, { role: 'assistant', content: '' }]); setQ(''); setBusy('Thinking…')
    const patch = (f: (m: Msg) => Msg) => setMsgs(all => [...all.slice(0, -1), f(all[all.length - 1])])
    try {
      const res = await request('/api/chat', { method: 'POST', body: JSON.stringify({
        messages: history.filter(m => !m.error && m.content).slice(-20).map(m => ({ role: m.role, content: m.content.slice(0, m.role === 'user' ? 1000 : 4000) })),
        today: new Date().toLocaleDateString('en-CA'),
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
      patch(m => ({ ...m, content: m.content || (x as Error).message, error: !m.content }))
    } finally { setBusy('') }
  }

  const setCard = (mi: number, ci: number, p: Partial<Card>) =>
    setMsgs(all => all.map((m, i) => (i === mi ? { ...m, cards: m.cards?.map((c, j) => (j === ci ? { ...c, ...p } as Card : c)) } : m)))

  return (
    <div className="chat-scrim" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <section className="chat" role="dialog" aria-modal="true" aria-labelledby="chat-title">
        <header className="chat-head">
          <Plico mood={busy ? 'thinking' : 'idle'} size={32} />
          <h2 id="chat-title">Ask Plico</h2>
          {msgs.length > 0 && <button className="iconbtn" aria-label="Clear this chat" onClick={() => setMsgs([])}><Icon n="trash" size={20} /></button>}
          <button className="iconbtn" aria-label="Close" onClick={onClose}><Icon n="close" /></button>
        </header>
        <div className="chat-log" role="log" aria-live="polite" aria-busy={!!busy}>
          {!msgs.length && (
            <div className="chat-empty">
              <p><strong>Ask about your groups and money.</strong>I can look things up, and get an expense, a settle-up or a reminder ready for you to confirm.</p>
              <ul>{ASK.map(a => <li key={a}><button className="chip" onClick={() => void ask(a)}>{a}</button></li>)}</ul>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`bubble ${m.role}${m.error ? ' err' : ''}`}>
              {m.content ? <Rich text={m.content} /> : i === msgs.length - 1 && busy ? null : <p className="muted-ink">…</p>}
              {m.cards?.map((c, j) => <ActionCard key={j} c={c} set={p => setCard(i, j, p)} close={onClose} />)}
            </div>
          ))}
          {busy && <p className="chat-busy" role="status"><span className="dots" aria-hidden><i /><i /><i /></span>{busy}</p>}
          <div ref={end} />
        </div>
        <form className="chat-in" onSubmit={e => { e.preventDefault(); void ask(q) }}>
          <textarea ref={input} rows={1} value={q} maxLength={1000} placeholder="Ask about your balances, spending…" aria-label="Your question"
            onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(q) } }} />
          <button className="chat-send" disabled={!q.trim() || !!busy} aria-label="Send"><Icon n="send" size={20} /></button>
        </form>
        <p className="chat-fine">Answers come from your Plico data via AI and can be wrong. Nothing changes until you tap.</p>
      </section>
    </div>
  )
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

/** A drafted action. The server's member ids map to this phone's copy of the group (you are ME here). */
function ActionCard({ c, set, close }: { c: Card; set: (p: Partial<Card>) => void; close: () => void }) {
  const s = useStore()
  const g = s.groups.find(x => x.id === c.groupId)
  const local = (id: string) => (id === g?.selfId ? ME : id)
  const known = (ids: string[]) => !!g && ids.every(id => g.members.some(m => m.id === local(id)))
  const act = async () => {
    if (!g) return set({ err: 'That group isn’t on this phone yet. Give it a moment to sync, then ask again.' })
    if (c.type === 'expense') {
      if (!known([...Object.keys(c.paid), ...Object.keys(c.owed)])) return set({ err: 'People in that group changed. Ask again.' })
      const map = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [local(k), v]))
      update(d => { d.groups.find(x => x.id === g.id)?.expenses.push({ id: uid(), title: c.title, cat: c.cat, date: c.date, amount: c.amount, paid: map(c.paid), owed: map(c.owed), mode: 'equal' }) })
      set({ done: 'Added' })
    } else if (c.type === 'settle') {
      if (!known([c.from, c.to])) return set({ err: 'People in that group changed. Ask again.' })
      close(); go(`/g/${g.id}/pay/${local(c.from)}/${local(c.to)}/${c.amount}`)
    } else {
      try { await api(`/api/groups/${g.id}/remind`, { method: 'POST', body: JSON.stringify({ memberId: c.memberId, amount: c.amount }) }); set({ done: 'Reminder sent' }) }
      catch (e) { set({ err: (e as Error).message }) }
    }
  }
  const label = c.type === 'expense' ? `Add ${inr(c.amount)}` : c.type === 'settle' ? 'Open settle up' : 'Send reminder'
  return (
    <div className="action-card">
      <p><Icon n={c.type === 'expense' ? 'plus' : c.type === 'settle' ? 'cash' : 'bell'} size={18} /><span>{c.summary}</span></p>
      {c.done ? <p className="action-done"><Icon n="check" size={16} />{c.done}{c.type === 'expense' && g && <button className="link" onClick={() => { close(); go('/g/' + g.id) }}>Open {c.group}</button>}</p>
        : <button className="btn-sm" onClick={() => void act()}>{label}</button>}
      {c.err && <p className="error" role="alert">{c.err}</p>}
    </div>
  )
}
