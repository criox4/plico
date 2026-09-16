import { Capacitor } from '@capacitor/core'
import { createAuthClient } from 'better-auth/react'
import { inferAdditionalFields } from 'better-auth/client/plugins'

// Web: same origin (Vite proxies /api in dev). Native apps: set VITE_API_URL to the deployed https API.
export const API = import.meta.env.VITE_API_URL || ''

// Web: the session lives in an httpOnly same-origin cookie, out of reach of scripts. Native apps can't rely on
// cookies across origins, so they keep the bearer token (app-sandboxed storage).
// ponytail: native token in WebView localStorage; move to Keychain/Keystore (secure-storage plugin) if the threat model grows.
const KEY = 'splittr-token'
const native = Capacitor.isNativePlatform()
if (!native) localStorage.removeItem(KEY) // drop tokens stored by older web builds
export const token = {
  get: () => (native ? localStorage.getItem(KEY) ?? '' : ''),
  set: (t: string) => { if (native) localStorage.setItem(KEY, t) },
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
