import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// drizzle-kit is a standalone CLI, so it does not get Next.js's automatic
// .env.local loading. Load it explicitly, matching Next's precedence.
config({ path: ['.env.local', '.env'] })

/**
 * Migrations run over the DIRECT (non-pooled) connection.
 *
 * Neon's pooler runs in transaction mode, which does not support the session
 * level statements DDL and advisory locks rely on — migrations against the
 * pooled URL fail intermittently and confusingly. The application uses the
 * pooled URL; only migrations use this one.
 */
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL

if (!url) {
  throw new Error(
    'DATABASE_URL_UNPOOLED (or DATABASE_URL) must be set to run migrations. ' +
      'Copy .env.example to .env.local and fill it in.',
  )
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
