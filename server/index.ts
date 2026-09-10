import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { ORIGINS, auth } from './auth.ts'
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
app.route('/api', api)
app.get('/health', c => c.text('ok'))

const port = Number(process.env.PORT) || 8787
serve({ fetch: app.fetch, port }, () => console.log(`Splittr API on http://localhost:${port}`))
