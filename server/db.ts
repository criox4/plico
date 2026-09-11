import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/prisma/client.ts'

// Pooled (pgbouncer, transaction mode) connection for the running app. Models are schema-qualified ("splittr", the pre-rename internal name).
export const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) })
