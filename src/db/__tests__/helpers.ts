import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'

import * as schema from '../schema'

/**
 * An in-process Postgres for tests.
 *
 * PGlite is real Postgres compiled to WASM, so CHECK constraints, composite
 * foreign keys and enums behave exactly as they do on Neon — which matters,
 * because the most important assertions in this suite are that the *database*
 * rejects certain writes. A mock or an in-memory stand-in could not prove that.
 *
 * It needs no Docker and no CI service container, so the suite stays free,
 * hermetic and identical locally and in CI.
 */
export async function createTestDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })

  const dir = join(process.cwd(), 'drizzle')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8')
    // Drizzle separates statements with this sentinel; PGlite's exec runs a
    // whole script, but splitting keeps failures attributable to a statement.
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.exec(trimmed)
    }
  }

  return { db, client }
}

export type TestDb = Awaited<ReturnType<typeof createTestDb>>['db']

/**
 * Runs a query expected to fail and returns the whole error chain as one
 * string.
 *
 * Drizzle wraps driver errors, so the top-level message is only
 * "Failed query: insert into ..." and the actual Postgres detail — the
 * constraint name we care about asserting on — sits in `.cause`. Matching on
 * the flattened chain keeps the assertions specific to the constraint rather
 * than merely "something threw".
 */
export async function dbErrorMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
  } catch (err: unknown) {
    const parts: string[] = []
    let current: unknown = err
    while (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    }
    if (current != null) parts.push(String(current))
    return parts.join(' | ')
  }
  throw new Error('expected the query to fail, but it succeeded')
}
