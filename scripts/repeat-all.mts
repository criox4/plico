// "Everyone" monthly repeats: saved and read back with the flag, and a member who leaves is set to 0 so later months skip them.
//   npx tsx --env-file=.env.development scripts/repeat-all.mts   (needs the dev API: `npm run server`)
import assert from 'node:assert/strict'
import { auth } from '../server/auth.ts'
import { db } from '../server/db.ts'

const API = process.env.RACE_API ?? 'http://localhost:8787'
const run = Date.now()
async function person(name: string) {
  const email = `repeat-${name}-${run}@splittr.test`
  const r = await auth.api.signUpEmail({ body: { name, email, password: 'password123' }, returnHeaders: true })
  await db.user.update({ where: { id: r.response.user.id }, data: { ageGroup: 'adult', emailVerified: true } })
  const token = r.headers.get('set-auth-token')!
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return { status: res.status, ...(await res.json() as any) }
  }
  return { id: r.response.user.id, call }
}
const [A, B] = await Promise.all([person('a'), person('b')])
const gid = crypto.randomUUID(), self = crypto.randomUUID(), eid = crypto.randomUUID()
try {
  await A.call('PUT', `/api/groups/${gid}`, { name: 'Flat', kind: 'home', theme: 'classic', selfId: self, create: true })
  const code = (await A.call('GET', `/api/groups/${gid}/invite`)).code
  await B.call('POST', `/api/invites/${code}/join`, {})
  const bid = (await db.member.findFirstOrThrow({ where: { groupId: gid, userId: B.id } })).id
  const put = await A.call('PUT', `/api/groups/${gid}/expenses/${eid}`, { title: 'Rent', cat: 'rent', date: '2026-11-01', amount: 1000, paid: { [self]: 1000 }, owed: { [self]: 1000 }, mode: 'equal', input: { [self]: 1 }, repeat: { next: '2026-12-01', day: 1, all: true }, base: null })
  assert.equal(put.status, 200, JSON.stringify(put))
  const e = (await A.call('GET', '/api/groups')).groups.find((g: any) => g.id === gid).expenses.find((x: any) => x.id === eid)
  assert.equal(e.repeatAll, true)
  // B is settled (owes nothing), so B can leave; the repeat now skips B.
  assert.equal((await B.call('POST', `/api/groups/${gid}/leave`)).status, 200)
  const after = await db.expense.findUniqueOrThrow({ where: { id: eid } })
  assert.equal((after.input as Record<string, number>)[bid], 0)
  assert.equal(after.version, 2)
  console.log('repeat-all ok')
} finally {
  await db.group.deleteMany({ where: { id: gid } })
  await db.user.deleteMany({ where: { id: { in: [A.id, B.id] } } })
  await db.$disconnect()
}
