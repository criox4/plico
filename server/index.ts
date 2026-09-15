import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ORIGINS, auth } from './auth.ts'
import { api } from './api.ts'
import { BUCKET, getFile } from './storage.ts'
import { aiReady } from './ai.ts'

const app = new Hono()

app.use('/api/*', cors({
  origin: ORIGINS,
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  exposeHeaders: ['set-auth-token'],
  credentials: true,
  maxAge: 600,
}))
app.on(['GET', 'POST'], '/api/auth/*', c => auth.handler(c.req.raw))
// Public: which sign-in methods exist (the client hides Google until it's configured).
app.get('/api/config', c => c.json({
  google: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  googleWebClientId: process.env.GOOGLE_CLIENT_ID ?? null,
  googleIosClientId: process.env.GOOGLE_IOS_CLIENT_ID ?? null,
  ai: aiReady(),
}))
// Public: profile pictures (random names; shown to anyone in a shared group, and <img> can't send a bearer token).
app.get('/api/files/avatars/:uid/:name', async c => {
  const { uid, name } = c.req.param()
  if (!/^[\w-]{1,64}$/.test(uid) || !/^[\w-]{1,64}\.(jpg|png|webp)$/.test(name)) return c.notFound()
  const f = await getFile(BUCKET.public, `${uid}/${name}`)
  if (!f) return c.notFound()
  return c.body(new Uint8Array(f.body), 200, { 'content-type': f.type, 'cache-control': 'public, max-age=31536000, immutable' })
})
app.route('/api', api)
app.get('/health', c => c.text('ok'))

const port = Number(process.env.PORT) || 8787
serve({ fetch: app.fetch, port }, () => console.log(`Plico API on http://localhost:${port}`))
