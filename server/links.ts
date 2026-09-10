import { db } from './db.ts'

/** Splitwise-style: every guest spot added under this verified email becomes this user's, unless they're already in that group. */
export async function linkByEmail(userId: string, email: string) {
  const { count } = await db.member.updateMany({
    where: { email: { equals: email.trim(), mode: 'insensitive' }, userId: null, group: { members: { none: { userId } } } },
    data: { userId, inviteToken: null },
  })
  return count
}
