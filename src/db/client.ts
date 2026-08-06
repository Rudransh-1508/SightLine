import { Pool } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-serverless'

import * as schema from './schema'

/**
 * Application database client.
 *
 * Uses the WebSocket-based `neon-serverless` driver rather than `neon-http`,
 * for one decisive reason: **neon-http has no transaction support at all.**
 * Its `transaction()` throws `"No transactions support in neon-http driver"`.
 *
 * That matters because approving a proposal (src/lib/review.ts) writes to
 * several tables at once — creating nodes, creating or updating an edge,
 * appending revisions, and flipping the proposal's status. A partial apply
 * would corrupt the graph, so those writes must be atomic.
 *
 * The trap this avoids: the test suite runs on PGlite, which DOES implement
 * `transaction()`. Had the app stayed on neon-http, every transactional test
 * would have passed while production threw at runtime — the failure would
 * only have surfaced against the real database. Both drivers now support the
 * same primitive, so the tests exercise the production code path.
 *
 * Verified live against Neon before adopting: an interactive transaction
 * succeeds, and a throw mid-transaction genuinely rolls back its writes.
 *
 * Uses the POOLED connection: serverless functions open many short-lived
 * connections, and Neon's pooler is what keeps that from exhausting the
 * database's connection limit. Migrations deliberately use the direct
 * connection instead — see drizzle.config.ts.
 *
 * The connection is created LAZILY, on first query rather than on import.
 * ES module imports are hoisted, so a top-level connection would be built
 * before any caller had a chance to load environment variables — which broke
 * the seed script, and would equally break `next build` in an environment
 * without DATABASE_URL set.
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.')
  }
  return url
}

type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>

let instance: DrizzleDb | null = null

export function getDb(): DrizzleDb {
  if (!instance) {
    instance = drizzle(new Pool({ connectionString: connectionString() }), { schema })
  }
  return instance
}

/**
 * Convenience handle. Behaves exactly like the Drizzle client, but resolves the
 * underlying connection on first property access rather than at import time.
 */
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop, receiver) {
    const real = getDb()
    const value = Reflect.get(real, prop, receiver)
    // Drizzle's builder methods depend on `this`, so rebind them to the real
    // client — an unbound reference would lose its internal session.
    return typeof value === 'function' ? value.bind(real) : value
  },
})

export type Db = DrizzleDb
export { schema }
