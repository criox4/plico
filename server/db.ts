import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.ts'

// Pooled (pgbouncer, transaction mode) connection for the running app. Models are schema-qualified ("splittr", the pre-rename internal name).
// Writes to one group queue on its audit lock (server/audit.ts), so transactions may wait on each other: allow for it.
export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }), transactionOptions: { maxWait: 15_000, timeout: 30_000 } })
