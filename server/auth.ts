import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { bearer } from 'better-auth/plugins'
import { db } from './db.ts'
import { isVpa } from '../src/logic.ts'
import { THEMES } from '../src/themes.ts'

// Web dev/preview, Capacitor iOS (capacitor://) and Android (https://localhost), plus the deployed web app.
export const ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'capacitor://localhost', 'https://localhost',
  ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : [])]

const TONES = ['gentle', 'normal', 'shameless']

export const auth = betterAuth({
  database: prismaAdapter(db, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  trustedOrigins: ORIGINS,
  user: {
    additionalFields: {
      upi: { type: 'string', required: false },
      theme: { type: 'string', required: false, defaultValue: 'classic' },
      tone: { type: 'string', required: false, defaultValue: 'gentle' },
    },
  },
  databaseHooks: {
    user: {
      // Profile fields are user input shown to others (UPI IDs end up in pay links): validate at the boundary.
      update: {
        before: async data => {
          if (data.upi && !isVpa(String(data.upi))) return false
          if (data.theme && !THEMES.some(t => t.id === data.theme)) return false
          if (data.tone && !TONES.includes(String(data.tone))) return false
          return { data }
        },
      },
    },
  },
  // Native apps can't rely on cookies across origins: the bearer plugin returns a token in `set-auth-token`.
  plugins: [bearer()],
})
