// Phone verification over WhatsApp, the reverse way: the app shows a code, the person sends it to Plico's WhatsApp
// number from their own phone, and WhatsApp itself tells us which number it came from. Nothing to type, no SMS to pay
// for, and the number is proven rather than claimed. A "Yes, link it" tap from that same number finishes it.
// Needs WA_PHONE_ID, WA_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN and WA_NUMBER; without all five the webhook is a 404
// and the app hides the feature. Never logs a phone number or a message: only that something failed, and why.
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { db } from './db.ts'
import { limiter } from './ip.ts'
import { linkByPhone } from './audit.ts'
import { normPhone } from '../src/logic.ts'

const PHONE_ID = process.env.WA_PHONE_ID?.trim()
const TOKEN = process.env.WA_TOKEN?.trim()
const SECRET = process.env.WA_APP_SECRET?.trim()
const VERIFY = process.env.WA_VERIFY_TOKEN?.trim()
const NUMBER = process.env.WA_NUMBER?.replace(/\D/g, '')
export const waReady = () => !!(PHONE_ID && TOKEN && SECRET && VERIFY && NUMBER)

const GRAPH = 'https://graph.facebook.com/v26.0' // the current Graph API version (July 2026)
const TTL = 10 * 60_000
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O or 1/I: read off a screen and typed if the prefill is lost

// ---------- pure parts (tested in whatsapp.test.ts) ----------
export const newCode = () => Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
export const codeIn = (text: string) => /PLICO-([A-Z0-9]{6})/i.exec(text)?.[1].toUpperCase() ?? null

/** Meta signs the exact bytes it sent: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(body, app secret) in hex. */
export function signedBy(raw: Uint8Array, header: string | undefined, secret: string) {
  const got = /^sha256=([a-f0-9]{64})$/i.exec(header ?? '')?.[1].toLowerCase()
  if (!got) return false
  const want = createHmac('sha256', secret).update(raw).digest('hex')
  return timingSafeEqual(Buffer.from(got), Buffer.from(want))
}

/** +91 98•••• 3210: enough for the owner to recognise, not enough to copy. */
export function mask(p: string) {
  if (/^\+91\d{10}$/.test(p)) return `+91 ${p.slice(3, 5)}•••• ${p.slice(-4)}`
  return p.slice(0, 4) + '•'.repeat(Math.max(p.length - 8, 2)) + p.slice(-4)
}

export type Inbound = { phone: string | null; to: { to: string } | { recipient: string } | null; at: number; text?: string; button?: string }
type Msg = { from?: string; from_user_id?: string; timestamp?: string; type?: string; text?: { body?: string }; interactive?: { type?: string; button_reply?: { id?: string } } }
type Body = { entry?: { changes?: { field?: string; value?: { messages?: Msg[] } }[] }[] }

/** The messages in a webhook delivery (status updates and anything else are skipped). `from` is the sender's number
 *  in digits; with WhatsApp usernames (from June 2026) it can be missing, leaving only a business-scoped user ID,
 *  which proves no number: `phone` is then null and we can only reply through `recipient`. */
export function inbound(body: unknown): Inbound[] {
  const out: Inbound[] = []
  for (const e of (body as Body)?.entry ?? []) for (const ch of e.changes ?? []) for (const m of ch.value?.messages ?? []) {
    const phone = m.from && /^\d{8,15}$/.test(m.from) ? normPhone('+' + m.from) : null
    out.push({
      phone,
      to: m.from ? { to: m.from } : m.from_user_id ? { recipient: m.from_user_id } : null,
      at: Number(m.timestamp) * 1000 || 0,
      ...(m.type === 'text' && { text: String(m.text?.body ?? '') }),
      ...(m.type === 'interactive' && m.interactive?.type === 'button_reply' && { button: String(m.interactive.button_reply?.id ?? '') }),
    })
  }
  return out
}

// ---------- sending ----------
async function send(to: Inbound['to'], msg: object) {
  if (!to) return
  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...to, ...msg }), signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) console.error(`WhatsApp send failed: ${r.status} ${((await r.json().catch(() => null)) as { error?: { code?: number } } | null)?.error?.code ?? ''}`)
  } catch (e) { console.error(`WhatsApp send failed: ${(e as Error).name}`) }
}
const say = (to: Inbound['to'], body: string) => send(to, { type: 'text', text: { body } })

// ---------- pending codes: Better Auth's verification table, identifier wa:<CODE>, value {"userId","phone"?} ----------
type Pending = { userId: string; phone?: string }
async function pending(code: string) {
  const v = await db.verification.findFirst({ where: { identifier: `wa:${code}`, expiresAt: { gt: new Date() } } })
  return v ? { id: v.id, ...(JSON.parse(v.value) as Pending) } : null
}
// ponytail: a scan of the value column; the table only holds short-lived codes. Index a userId column if it grows.
const mine = (userId: string) => ({ identifier: { startsWith: 'wa:' }, value: { contains: `"userId":"${userId}"` } })

const EXPIRED = 'That code has expired. Start again from Plico → Account.'
const chatty = limiter(3600_000, 1) // ponytail: per process, like every limiter here

async function handle(m: Inbound) {
  if (Date.now() - m.at > TTL) return // Meta retries for days; anything older than a code's life is stale
  if (m.button) {
    const [answer, code] = m.button.split(':')
    const p = code ? await pending(code) : null
    if (!p || !m.phone || p.phone !== m.phone) return say(m.to, EXPIRED)
    if (answer === 'no') { await db.verification.deleteMany({ where: { id: p.id } }); return say(m.to, 'Okay, nothing changed.') }
    if (answer !== 'yes') return
    const phone = m.phone
    const done = await db.$transaction(async tx => {
      const { count } = await tx.verification.deleteMany({ where: { id: p.id } })
      if (!count) return false // a retried delivery: the first one already did it
      // Numbers get recycled: whoever proved this number before loses it to whoever holds it now.
      await tx.user.updateMany({ where: { verifiedPhone: phone, id: { not: p.userId } }, data: { verifiedPhone: null, phoneVerifiedAt: null } })
      await tx.user.update({ where: { id: p.userId }, data: { verifiedPhone: phone, phoneVerifiedAt: new Date(), phone } })
      return true
    })
    if (!done) return
    await linkByPhone(p.userId, phone)
    return say(m.to, 'Done. Your number is linked to Plico.')
  }
  if (m.text === undefined) return
  const code = codeIn(m.text)
  if (!code) {
    const k = m.phone ?? JSON.stringify(m.to)
    if (chatty.full(k)) return
    chatty.hit(k)
    return say(m.to, 'This number only verifies phone numbers for Plico.')
  }
  const p = await pending(code)
  if (!p) return say(m.to, EXPIRED)
  if (!m.phone) return say(m.to, 'We couldn’t read your phone number from WhatsApp, so it can’t be verified this way.')
  await db.verification.update({ where: { id: p.id }, data: { value: JSON.stringify({ userId: p.userId, phone: m.phone }) } })
  const u = await db.user.findUnique({ where: { id: p.userId }, select: { name: true } })
  const first = u?.name.trim().split(/\s+/)[0]
  return send(m.to, { type: 'interactive', interactive: {
    type: 'button',
    body: { text: `Link ${mask(m.phone)} to ${first ? `${first}’s` : 'your'} Plico account?` },
    action: { buttons: [{ type: 'reply', reply: { id: `yes:${code}`, title: 'Yes, link it' } }, { type: 'reply', reply: { id: `no:${code}`, title: 'No' } }] },
  } })
}

// ---------- the webhook, public: Meta calls it, so its signature is the only proof ----------
export const whatsapp = new Hono()
whatsapp.use('*', async (c, next) => (waReady() ? next() : c.notFound()))
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
// Meta's one-time check when the webhook URL is saved in the app dashboard.
whatsapp.get('/', c => (c.req.query('hub.mode') === 'subscribe' && same(c.req.query('hub.verify_token') ?? '', VERIFY!) ? c.text(c.req.query('hub.challenge') ?? '') : c.text('Forbidden', 403)))
whatsapp.post('/', bodyLimit({ maxSize: 1 << 20 }), async c => {
  const raw = new Uint8Array(await c.req.arrayBuffer()) // the exact bytes: re-serialised JSON wouldn't match the signature
  if (!signedBy(raw, c.req.header('x-hub-signature-256'), SECRET!)) return c.text('Bad signature', 401)
  let body: unknown
  try { body = JSON.parse(new TextDecoder().decode(raw)) } catch { return c.text('ok') }
  // Answer at once and work after: Meta wants a quick 200, and a slow reply would only bring a retry.
  for (const m of inbound(body)) void handle(m).catch(e => console.error(`WhatsApp webhook failed: ${(e as Error).name}`))
  return c.text('ok')
})
