// One-off: rebuild the audit chain for groups that have none yet (existing data at the people/audit migration).
//   npx tsx --env-file=.env.development scripts/backfill-audit.mts
import { audit } from '../server/audit.ts'
import { db } from '../server/db.ts'

const groups = await db.group.findMany({ where: { auditSeq: 0 }, include: {
  members: { orderBy: { createdAt: 'asc' }, include: { user: { select: { name: true } } } },
  expenses: { orderBy: { createdAt: 'asc' }, include: { shares: { select: { memberId: true, paid: true, owed: true } } } },
} })
for (const g of groups) {
  const creator = g.members.find(m => m.userId && m.userId === g.createdById) ?? g.members[0]
  const by = { byId: g.createdById, byName: creator?.user?.name ?? creator?.name ?? 'Someone' }
  await db.$transaction(async tx => {
    await audit(tx, g.id, { kind: 'group.created', memberId: creator?.id, ...by, after: { name: g.name, kind: g.kind, theme: g.theme } })
    for (const m of g.members) if (m.id !== creator?.id)
      await audit(tx, g.id, { kind: m.userId ? 'member.joined' : 'member.invited', memberId: m.id, ...by, after: { name: m.name, email: m.email } })
    for (const e of g.expenses) {
      const snap = { title: e.title, cat: e.cat, date: e.date, amount: e.amount, mode: e.mode, input: e.input, settle: e.settle, pending: e.pending, rejected: e.rejected,
        receipt: e.receipt, repeatNext: e.repeatNext, repeatDay: e.repeatDay,
        shares: e.shares.filter(x => x.paid || x.owed).sort((a, b) => a.memberId.localeCompare(b.memberId)) }
      await audit(tx, g.id, { kind: 'expense.created', expenseId: e.id, version: 1, ...by, after: snap })
      if (e.deletedAt) await audit(tx, g.id, { kind: 'expense.deleted', expenseId: e.id, version: 2, ...by, before: snap })
      if (e.version !== (e.deletedAt ? 2 : 1)) await tx.expense.update({ where: { id: e.id }, data: { version: e.deletedAt ? 2 : 1 } })
    }
  }, { timeout: 60_000 })
  console.log(`${g.name}: ${g.members.length} people, ${g.expenses.length} expenses`)
}
console.log(`rebuilt ${groups.length} audit chains`)
await db.$disconnect()
