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
// Sign in with Apple, iOS only: the app sends Apple's ID token, checked against Apple's keys with our bundle id as audience.
// No secret needed for that; the web redirect flow (Services ID + .p8 key) isn't offered.
const apple = { apple: { clientId: 'app.plico', clientSecret: '', appBundleIdentifier: 'app.plico' } }

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: 'postgresql' }),
  trustedOrigins: ORIGINS,
  // Brute-force protection on sign-in, sign-up and reset (per IP). Better Auth's own stricter per-path rules still apply.
  rateLimit: { enabled: true, window: 60, max: 60 },
  // Behind Vercel the client IP arrives in a header the platform sets (clients can't spoof it there).
  advanced: { ipAddress: { ipAddressHeaders: ['x-vercel-forwarded-for', 'x-forwarded-for'] } },
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
  socialProviders: { ...google, ...apple },
  // One account per email, however you sign in: Google or Apple with the same (verified) email joins the existing account.
  // requireLocalEmailVerified is off so an unverified email sign-up can still be joined; the account hook below makes that safe.
  account: { accountLinking: { enabled: true, trustedProviders: ['google', 'apple'], requireLocalEmailVerified: false,
    // Connecting from inside the app (signed in already) may use another email, e.g. Apple's Hide My Email.
    allowDifferentEmails: true } },
  user: {
    additionalFields: {
      upi: { type: 'string', required: false },
      phone: { type: 'string', required: false },
      theme: { type: 'string', required: false, defaultValue: 'classic' },
      tone: { type: 'string', required: false, defaultValue: 'gentle' },
      // Read-only to the client (set through /api/me/* so a teen can't un-teen themselves).
      ageGroup: { type: 'string', required: false, input: false },
      guardianEmail: { type: 'string', required: false, input: false },
      guardianConsentAt: { type: 'date', required: false, input: false },
      aiConsentAt: { type: 'date', required: false, input: false },
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
    account: {
      create: {
        after: async (acc, ctx) => {
          if (acc.providerId !== 'google' && acc.providerId !== 'apple') return
          const u = await db.user.findUnique({ where: { id: acc.userId } })
          if (!u || u.emailVerified) return
          // Connected from inside the app by the signed-in owner: nothing to clean up.
          const me = ctx?.headers && await auth.api.getSession({ headers: ctx.headers }).catch(() => null)
          if (me?.user.id === u.id) return
          // Google/Apple just proved this email is theirs, but the account was an unverified email sign-up:
          // anyone could have made it. Drop that password and its sessions so it can't be used to get in, then trust the email.
          await db.account.deleteMany({ where: { userId: u.id, providerId: 'credential' } })
          await db.session.deleteMany({ where: { userId: u.id } })
          await db.user.update({ where: { id: u.id }, data: { emailVerified: true } })
          await linkByEmail(u.id, u.email)
        },
      },
    },
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
          // Profile picture: our uploaded file, a Google photo, an emoji, or a Plico face seed.
          if (data.image && !/^(\/api\/files\/avatars\/[\w/-]+\.(jpg|png|webp)|https:\/\/[^\s"<>]{1,500}|plico:[0-9a-f]{6}|emoji:(?=.*\p{Extended_Pictographic})\S{1,16})$/u.test(String(data.image))) return false
          return { data }
        },
        after: async u => { if (u.emailVerified) await linkByEmail(u.id, u.email) },
      },
    },
  },
  // Native apps can't rely on cookies across origins: the bearer plugin returns a token in `set-auth-token`.
  plugins: [bearer()],
})
