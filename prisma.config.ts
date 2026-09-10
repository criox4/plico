import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// The CLI (migrate) needs a direct session-mode connection; the running server uses the pooled DATABASE_URL.
// ?schema=splittr keeps Prisma's own _prisma_migrations table (and its emptiness check) out of public.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: `${env('DIRECT_URL')}?schema=splittr` },
})
