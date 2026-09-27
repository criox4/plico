// The money audit: every change to an expense, a person or a group is appended to its group's log in the same
// transaction, hash-chained (sha256 of the previous hash + the canonical entry) so rewriting history shows.
import { createHash } from 'node:crypto'
import { auditPayload, effectOf, type AuditEntry, type Snap } from '../src/logic.ts'
import { Prisma } from './generated/prisma/client.ts'
import { db } from './db.ts'
import { queuePush } from './push.ts'

type Tx = Prisma.TransactionClient
export type Entry = Pick<AuditEntry, 'kind' | 'expenseId' | 'memberId' | 'version' | 'revertOf' | 'byId' | 'byName' | 'before' | 'after' | 'via'>
const json = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue))

/** Append one entry. Locks the group row (NO KEY UPDATE: compatible with the key-share locks that inserting
 * an expense or member takes on it, so no deadlock), so concurrent writers queue and the chain has no forks or gaps. */
export async function audit(tx: Tx, groupId: string, e: Entry) {
  const [head] = await tx.$queryRaw<{ auditSeq: number; auditHash: string }[]>`SELECT "auditSeq", "auditHash" FROM "splittr"."group" WHERE "id" = ${groupId} FOR NO KEY UPDATE`
  if (!head) throw new Error('Group not found')
  // Only expense entries move money; people and group entries have no effect.
  const effect = e.kind.startsWith('expense.') ? effectOf((e.before as Snap) ?? null, (e.after as Snap) ?? null) : {}
  const entry: AuditEntry = { ...e, groupId, seq: head.auditSeq + 1, at: new Date().toISOString(), effect, prevHash: head.auditHash }
  const hash = createHash('sha256').update(entry.prevHash + auditPayload(entry)).digest('hex')
  await tx.auditEvent.create({ data: {
    groupId, seq: entry.seq, kind: e.kind, expenseId: e.expenseId ?? null, memberId: e.memberId ?? null, version: e.version ?? null, revertOf: e.revertOf ?? null,
    byId: e.byId ?? null, byName: e.byName, via: e.via ?? null, at: new Date(entry.at), before: json(e.before), after: json(e.after), effect, prevHash: entry.prevHash, hash,
  } })
  await tx.group.update({ where: { id: groupId }, data: { auditSeq: entry.seq, auditHash: hash } })
  await queuePush(tx, groupId, { ...e, effect }) // same transaction: a push exists exactly when its change does
}

/** The fields of an object that differ, as { before, after } holding just those. */
export function changed<T extends Record<string, unknown>>(a: T, b: T) {
  const keys = Object.keys(b).filter(k => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
  return keys.length ? { before: Object.fromEntries(keys.map(k => [k, a[k] ?? null])), after: Object.fromEntries(keys.map(k => [k, b[k] ?? null])) } : null
}

/** Splitwise-style: every spot added under this verified email becomes this user's, unless they're already in that group. */
export async function linkByEmail(userId: string, email: string) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { name: true } })
  const spots = await db.member.findMany({ where: { email: { equals: email.trim(), mode: 'insensitive' }, userId: null, group: { members: { none: { userId } } } } })
  for (const m of spots) {
    await db.$transaction(async tx => {
      // Their account's own name replaces whatever the inviter typed.
      const { count } = await tx.member.updateMany({ where: { id: m.id, userId: null }, data: { userId, inviteToken: null, ...(user?.name && { name: user.name }) } })
      if (count) await audit(tx, m.groupId, { kind: 'member.joined', memberId: m.id, byId: userId, byName: user?.name ?? m.name, after: { name: m.name, email: m.email, how: 'email' } })
    })
  }
  return spots.length
}
