import { httpTelemetry } from './otel.ts' // first: telemetry must be set up before anything else loads
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { bodyLimit } from 'hono/body-limit'
import { secureHeaders } from 'hono/secure-headers'
import { ORIGINS, auth } from './auth.ts'
import { api, publicApi } from './api.ts'
import { BUCKET, getFile } from './storage.ts'
import { aiReady } from './ai.ts'
import { pushConfig, startPush } from './push.ts'
import { IP_HEADER, clientIp, limiter } from './ip.ts'

const app = new Hono()

app.use('/api/*', httpTelemetry)
app.use('*', secureHeaders({ crossOriginResourcePolicy: 'cross-origin' })) // cross-origin: native apps load avatars
// Everything but photo uploads is small JSON; big bodies are refused before they're read.
app.use('/api/*', async (c, next) => (/\/(files|avatar|ai\/read|chat)$/.test(c.req.path) ? next() : bodyLimit({ maxSize: 256 << 10 })(c, next)))
app.use('/api/*', cors({
  origin: ORIGINS,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['set-auth-token'],
  credentials: true,
  maxAge: 600,
}))
// The caller's IP, from a source they can't forge, for Better Auth's per-IP limits and ours.
app.use('/api/*', async (c, next) => { c.req.raw.headers.set(IP_HEADER, clientIp(c)); await next() })
// Per account, on top of per IP: someone guessing one person's password from many addresses still stops after 10 misses.
// Keyed by the email typed, so a lockout lasts 15 minutes at most and a reset link always works.
const misses = limiter(15 * 60_000, 10)
app.post('/api/auth/sign-in/email', async (c, next) => {
  const body = await c.req.raw.clone().json().catch(() => null) as { email?: unknown } | null
  const who = String(body?.email ?? '').trim().toLowerCase().slice(0, 254)
  if (who && misses.full(who)) return c.json({ code: 'TOO_MANY_ATTEMPTS', message: 'Too many wrong passwords for this account. Wait 15 minutes, or reset your password.' }, 429)
  await next()
  if (!who) return
  if (c.res.status === 401) misses.hit(who)
  else if (c.res.ok) misses.clear(who)
})
app.on(['GET', 'POST'], '/api/auth/*', c => auth.handler(c.req.raw))
// Public: which sign-in methods exist (the client hides Google until it's configured).
app.get('/api/config', c => c.json({
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  googleWebClientId: process.env.GOOGLE_CLIENT_ID ?? null,
  googleIosClientId: process.env.GOOGLE_IOS_CLIENT_ID ?? null,
  ai: aiReady(),
  push: pushConfig(), // which push channels this server can send on; web carries the VAPID public key
}))
// Public: profile pictures (random names; shown to anyone in a shared group, and <img> can't send a bearer token).
app.get('/api/files/avatars/:uid/:name', async c => {
  const { uid, name } = c.req.param()
  if (!/^[\w-]{1,64}$/.test(uid) || !/^[\w-]{1,64}\.(jpg|png|webp)$/.test(name)) return c.notFound()
  const f = await getFile(BUCKET.public, `${uid}/${name}`)
  if (!f) return c.notFound()
  return c.body(new Uint8Array(f.body), 200, { 'content-type': f.type, 'cache-control': 'public, max-age=31536000, immutable' })
})
app.route('/api', publicApi)
app.route('/api', api)
app.get('/health', c => c.text('ok'))

const port = Number(process.env.PORT) || 8787
serve({ fetch: app.fetch, port }, () => console.log(`Plico API on http://localhost:${port}`))
startPush()
