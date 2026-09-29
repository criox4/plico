// A small admin page at /admin: how many people, groups and expenses, what AI costs, whether push and email flow.
// Its own login, separate from Plico accounts: one email (ADMIN_EMAIL) and a password whose scrypt hash is in
// ADMIN_PASSWORD_HASH (make one with `npm run admin:password`). Without both, /admin doesn't exist. The session is a
// signed cookie keyed by the hash too, so changing the password signs every admin session out. Totals only: no names,
// emails or amounts of anyone in particular.
import { createHmac, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { db } from './db.ts'
import { clientIp, limiter } from './ip.ts'
import { inr } from '../src/logic.ts'

const EMAIL = process.env.ADMIN_EMAIL?.trim().toLowerCase()
const HASH = process.env.ADMIN_PASSWORD_HASH?.trim() // scrypt$<salt hex>$<key hex>
const COOKIE = '__Host-plico-admin'
const HOURS = 12
const key = () => `${process.env.BETTER_AUTH_SECRET}:${HASH}`
const derive = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>

/** scrypt, the same format scripts/admin-password.mts writes. */
export const hashPassword = async (pw: string, salt: Buffer) => `scrypt$${salt.toString('hex')}$${(await derive(pw, salt, 64)).toString('hex')}`

async function passwordOk(pw: string) {
  const [alg, salt, want] = HASH!.split('$')
  if (alg !== 'scrypt' || !salt || !want) return false
  const got = await derive(pw, Buffer.from(salt, 'hex'), 64)
  const exp = Buffer.from(want, 'hex')
  return got.length === exp.length && timingSafeEqual(got, exp)
}

const sign = (v: string) => createHmac('sha256', key()).update(v).digest('hex')
function signedIn(c: Context) {
  const [exp, mac] = (getCookie(c, COOKIE) ?? '').split('.')
  if (!exp || !mac || Number(exp) < Date.now()) return false
  const a = Buffer.from(mac), b = Buffer.from(sign(exp))
  return a.length === b.length && timingSafeEqual(a, b)
}

// Five wrong tries per address per 15 minutes; the rest wait.
const tries = limiter(15 * 60_000, 5)

export const admin = new Hono()

admin.use('*', async (c, next) => {
  if (!EMAIL || !HASH || !process.env.BETTER_AUTH_SECRET) return c.notFound()
  await next()
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
  c.header('Cache-Control', 'no-store')
  c.header('X-Robots-Tag', 'noindex, nofollow')
})

admin.get('/', async c => (signedIn(c) ? c.html(page('Plico admin', await dashboard())) : c.html(page('Plico admin', login()))))

admin.post('/login', async c => {
  const ip = clientIp(c)
  if (tries.full(ip)) return c.html(page('Plico admin', login('Too many tries. Wait 15 minutes.')), 429)
  const f = await c.req.parseBody()
  const email = String(f.email ?? '').trim().toLowerCase()
  const ok = email === EMAIL && (await passwordOk(String(f.password ?? '')))
  if (!ok) { tries.hit(ip); return c.html(page('Plico admin', login('That email and password don’t match.')), 401) }
  tries.clear(ip)
  const exp = String(Date.now() + HOURS * 3600_000)
  setCookie(c, COOKIE, `${exp}.${sign(exp)}`, { path: '/', httpOnly: true, secure: true, sameSite: 'Strict', maxAge: HOURS * 3600 })
  return c.redirect('/admin', 303)
})

admin.post('/logout', c => { deleteCookie(c, COOKIE, { path: '/', secure: true }); return c.redirect('/admin', 303) })

// ---------- numbers (cached a minute: the page is for a glance, not live monitoring) ----------
let cache: { at: number; html: string } | undefined
async function dashboard() {
  if (cache && Date.now() - cache.at < 60_000) return cache.html
  const now = Date.now(), ago = (d: number) => new Date(now - d * 86400_000)
  const [users, new7, new30, active, groups, kinds, groups7, guests, spend, settled, pending, aiActs, aiActs7, invites, devices, waiting, sent24, ai] = await Promise.all([
    db.user.count(),
    db.user.count({ where: { createdAt: { gte: ago(7) } } }),
    db.user.count({ where: { createdAt: { gte: ago(30) } } }),
    db.session.groupBy({ by: ['userId'], where: { updatedAt: { gte: ago(7) } } }).then(r => r.length),
    db.group.count(),
    db.group.groupBy({ by: ['kind'], _count: true }),
    db.group.count({ where: { createdAt: { gte: ago(7) } } }),
    db.member.count({ where: { userId: null } }),
    db.expense.aggregate({ where: { deletedAt: null, settle: false }, _count: true, _sum: { amount: true } }),
    db.expense.aggregate({ where: { deletedAt: null, settle: true, pending: false, rejected: false }, _count: true, _sum: { amount: true } }),
    db.expense.count({ where: { deletedAt: null, settle: true, pending: true } }),
    db.auditEvent.count({ where: { via: 'ai' } }),
    db.auditEvent.count({ where: { via: 'ai', at: { gte: ago(7) } } }),
    db.emailLog.count({ where: { at: { gte: ago(1) } } }),
    db.pushDevice.groupBy({ by: ['platform'], _count: true }),
    db.notification.count({ where: { sentAt: null } }),
    db.notification.count({ where: { sentAt: { gte: ago(1) }, skipped: null } }),
    openRouter(),
  ])
  const usd = (n: unknown) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—')
  const html = `
    <header><h1>Plico</h1><form method="post" action="/admin/logout"><button>Sign out</button></form></header>
    <p class="muted">As of ${new Date(now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST · refreshes at most once a minute</p>
    ${card('People', [['Accounts', users], ['New, 7 days', new7], ['New, 30 days', new30], ['Active, 7 days', active], ['Guests (no account)', guests]])}
    ${card('Groups', [['Groups', groups], ['New, 7 days', groups7], ...kinds.sort((a, b) => b._count - a._count).map(k => [cap(k.kind), k._count] as Row)])}
    ${card('Money', [['Expenses', spend._count], ['Spent, total', inr(spend._sum.amount ?? 0)], ['Settlements', settled._count], ['Settled, total', inr(settled._sum.amount ?? 0)], ['Waiting for payee', pending]])}
    ${card('AI (OpenRouter)', ai ? [['Today', usd(ai.usage_daily)], ['This week', usd(ai.usage_weekly)], ['This month', usd(ai.usage_monthly)], ['All time', usd(ai.usage)], ['Limit left', ai.limit == null ? 'no limit' : usd(ai.limit_remaining)], ['Ask Plico changes, all / 7 days', `${aiActs} / ${aiActs7}`]]
      : [['Spend', 'unavailable'], ['Ask Plico changes, all / 7 days', `${aiActs} / ${aiActs7}`]])}
    ${card('Push and email', [...devices.map(d => [`Devices, ${d.platform}`, d._count] as Row), ['Waiting to send', waiting], ['Sent, 24 h', sent24], ['Invite emails, 24 h', invites]])}
    <nav>${link(process.env.GRAFANA_URL, 'Grafana')}${link('https://criox4.sentry.io/issues/', 'Sentry')}${link('https://vercel.com/dashboard', 'Vercel')}${link('https://openrouter.ai/activity', 'OpenRouter')}</nav>`
  cache = { at: now, html }
  return html
}

/** Spend on the key the API uses, straight from OpenRouter (nothing is logged here). */
async function openRouter(): Promise<Record<string, number | null> | null> {
  if (!process.env.OPENROUTER_API_KEY) return null
  try {
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(5000) })
    return r.ok ? ((await r.json()) as { data: Record<string, number | null> }).data : null
  } catch { return null }
}

// ---------- markup ----------
type Row = [string, string | number]
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const card = (title: string, rows: Row[]) =>
  `<section><h2>${esc(title)}</h2><dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(typeof v === 'number' ? v.toLocaleString('en-IN') : v)}</dd></div>`).join('')}</dl></section>`
const link = (href: string | undefined, text: string) => (href ? `<a href="${esc(href)}" rel="noopener noreferrer" target="_blank">${esc(text)}</a>` : '')
const login = (err = '') => `
  <form class="login" method="post" action="/admin/login">
    <h1>Plico admin</h1>
    ${err ? `<p class="err" role="alert">${esc(err)}</p>` : ''}
    <label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button>Sign in</button>
  </form>`
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1b26;--muted:#6b6878;--line:#e6e3dc;--brand:#4f46e5;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121117;--card:#1b1a22;--ink:#eeecf5;--muted:#9a97a8;--line:#2c2a36;--brand:#8b85ff;--err:#ff8a80}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px 48px;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,sans-serif}
main{max-width:960px;margin:0 auto}header{display:flex;justify-content:space-between;align-items:center}
h1{font-size:22px;margin:0}h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
.muted{color:var(--muted);font-size:13px;margin:4px 0 20px}
main>section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
dl{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:14px;margin:0}
dt{color:var(--muted);font-size:13px}dd{margin:2px 0 0;font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
nav{display:flex;gap:16px;flex-wrap:wrap;margin-top:18px}a{color:var(--brand)}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:8px 14px;cursor:pointer}
.login{max-width:340px;margin:12vh auto;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;display:grid;gap:14px}
label{display:grid;gap:6px;font-size:13px;color:var(--muted)}
input{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.login button{background:var(--brand);border-color:var(--brand);color:#fff;padding:10px}.err{color:var(--err);margin:0}
</style></head><body><main>${body}</main></body></html>`
