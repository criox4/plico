import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { bearer } from 'better-auth/plugins'
import { db } from './db.ts'
import { mail } from './email.ts'
import { linkByEmail } from './links.ts'
import { isVpa } from '../src/logic.ts'
import { THEMES } from '../src/themes.ts'

// Web dev/preview, Capacitor iOS (capacitor://) and Android (https://localhost), plus the deployed web app.
export const ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'capacitor://localhost', 'https://localhost',
  ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : [])]

const TONES = ['gentle', 'normal', 'shameless']
const APP = process.env.PUBLIC_URL || 'http://localhost:5173'

// Google is optional: the button only appears (via /api/config) once credentials exist.
// One Google Cloud project, one client id per platform: web first (used for the redirect flow), then native ids for ID-token sign-in.
export const googleIds = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_ANDROID_CLIENT_ID, process.env.GOOGLE_IOS_CLIENT_ID].filter(Boolean) as string[]
const google = googleIds.length && process.env.GOOGLE_CLIENT_SECRET
  ? { google: { clientId: googleIds, clientSecret: process.env.GOOGLE_CLIENT_SECRET } } : undefined

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: 'postgresql' }),
  trustedOrigins: ORIGINS,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    revokeSessionsOnPasswordReset: true,
    // Not awaited: response time must not reveal whether an account exists.
    sendResetPassword: async ({ user, url }) => { void mail.reset(user.email, url).catch(console.error) },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => { void mail.verify(user.email, user.name, url).catch(console.error) },
  },
  socialProviders: google,
  account: { accountLinking: { enabled: true, trustedProviders: ['google'] } },
  user: {
    additionalFields: {
      upi: { type: 'string', required: false },
      phone: { type: 'string', required: false },
      theme: { type: 'string', required: false, defaultValue: 'classic' },
      tone: { type: 'string', required: false, defaultValue: 'gentle' },
    },
    changeEmail: {
      enabled: true,
      sendChangeEmailConfirmation: async ({ user, newEmail, url }) => { void mail.emailChanged(user.email, newEmail, url).catch(console.error) },
    },
    deleteUser: {
      enabled: true,
      // The mailed link opens the app (which holds the session) and finishes deletion with the token.
      sendDeleteAccountVerification: async ({ user, token }) => { void mail.deleteAccount(user.email, `${APP}/#/delete/${token}`).catch(console.error) },
    },
  },
  databaseHooks: {
    user: {
      // Verified email (Google sign-up, or a clicked verification link): groups friends added this email to appear.
      create: { after: async u => { if (u.emailVerified) await linkByEmail(u.id, u.email) } },
      // Profile fields are user input shown to others (UPI IDs end up in pay links): validate at the boundary.
      update: {
        before: async data => {
          if (data.upi && !isVpa(String(data.upi))) return false
          if (data.theme && !THEMES.some(t => t.id === data.theme)) return false
          if (data.tone && !TONES.includes(String(data.tone))) return false
          if (data.phone && !/^\+?[0-9 ()-]{7,20}$/.test(String(data.phone))) return false
          return { data }
        },
        after: async u => { if (u.emailVerified) await linkByEmail(u.id, u.email) },
      },
    },
  },
  // Native apps can't rely on cookies across origins: the bearer plugin returns a token in `set-auth-token`.
  plugins: [bearer()],
})
