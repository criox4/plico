// Makes the ADMIN_PASSWORD_HASH line for the admin page (server/admin.ts). The password is typed without echo and
// never written anywhere; only its scrypt hash is printed.
//   npm run admin:password
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { hashPassword } from '../server/admin.ts'

function ask(q: string) {
  return new Promise<string>(done => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const out = rl as unknown as { _writeToOutput: (s: string) => void }
    out._writeToOutput = s => { if (s.includes(q)) process.stdout.write(s) } // hide the typing
    rl.question(q, a => { rl.close(); process.stdout.write('\n'); done(a) })
  })
}

const pw = await ask('Admin password (12+ characters): ')
if (pw.length < 12) { console.error('Too short: use at least 12 characters (a password manager can make one).'); process.exit(1) }
if ((await ask('Again: ')) !== pw) { console.error('They don’t match.'); process.exit(1) }
console.log(`\nAdd to .env.production (and .env.development to try it locally):\nADMIN_PASSWORD_HASH=${await hashPassword(pw, randomBytes(16))}`)
