import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ORIGINS, auth, googleIds } from './auth.ts'
import { api } from './api.ts'

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
app.get('/api/config', c => c.json({ google: !!(googleIds.length && process.env.GOOGLE_CLIENT_SECRET), googleWebClientId: googleIds[0] ?? null }))
app.route('/api', api)
app.get('/health', c => c.text('ok'))

const port = Number(process.env.PORT) || 8787
serve({ fetch: app.fetch, port }, () => console.log(`Splittr API on http://localhost:${port}`))
