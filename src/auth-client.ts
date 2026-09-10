import { createAuthClient } from 'better-auth/react'
import { inferAdditionalFields } from 'better-auth/client/plugins'

// Web: same origin (Vite proxies /api in dev). Native apps: set VITE_API_URL to the deployed https API.
export const API = import.meta.env.VITE_API_URL || ''

// Bearer token instead of cookies so the web app and the Capacitor apps authenticate the same way.
const KEY = 'splittr-token'
export const token = {
  get: () => localStorage.getItem(KEY) ?? '',
  set: (t: string) => localStorage.setItem(KEY, t),
  clear: () => localStorage.removeItem(KEY),
}

export const authClient = createAuthClient({
  baseURL: API || location.origin,
  fetchOptions: {
    credentials: 'include', // web: same-origin session cookie (needed for Google's redirect flow)
    auth: { type: 'Bearer', token: () => token.get() },
    onSuccess: ctx => {
      const t = ctx.response.headers.get('set-auth-token')
      if (t) token.set(t)
    },
  },
  plugins: [inferAdditionalFields({
    user: {
      upi: { type: 'string', required: false },
      phone: { type: 'string', required: false },
      theme: { type: 'string', required: false },
      tone: { type: 'string', required: false },
    },
  })],
})
