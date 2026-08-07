import 'server-only'

import { withAuth } from '@workos-inc/authkit-nextjs'
import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { users, creditLedger } from '@/db/schema'

/**
 * The security boundary.
 *
 * Next's own documentation states that proxy is for optimistic checks and
 * "should not be used as a full session management or authorization solution".
 * So authorization lives here, in a Data Access Layer that every protected
 * route handler and server component calls for itself. Deleting src/proxy.ts
 * must change the UX (no early redirect) but must not expose any data.
 */

/** Credits granted the first time an account is seen. */
export const INITIAL_CREDIT_GRANT = 100

export interface AppUser {
  id: string
  workosUserId: string
  email: string
  creditBalance: number
}

/**
 * Verifies the session and returns the application user, provisioning a row on
 * first sight. Throws if there is no valid session — callers must not proceed.
 */
export async function requireUser(): Promise<AppUser> {
  const { user } = await withAuth({ ensureSignedIn: true })
  return provisionUser(user.id, user.email)
}

/**
 * Returns the application user when signed in, or null when not. For places
 * that vary their output by session but must not redirect.
 */
export async function getOptionalUser(): Promise<AppUser | null> {
  const { user } = await withAuth()
  if (!user) return null
  return provisionUser(user.id, user.email)
}

/**
 * Upserts the local user row for a WorkOS identity.
 *
 * The initial credit grant is written to the ledger, not just the balance
 * column: the ledger is the authoritative record and the column is a derived
 * cache. `onConflictDoNothing` keyed on workos_user_id makes this safe under
 * concurrent first requests — two parallel requests cannot double-grant.
 */
export async function provisionUser(workosUserId: string, email: string): Promise<AppUser> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.workosUserId, workosUserId))
    .limit(1)

  if (existing[0]) {
    const row = existing[0]
    return {
      id: row.id,
      workosUserId: row.workosUserId,
      email: row.email,
      creditBalance: row.creditBalance,
    }
  }

  const id = `usr_${workosUserId}`
  const inserted = await db
    .insert(users)
    .values({ id, workosUserId, email, creditBalance: INITIAL_CREDIT_GRANT })
    .onConflictDoNothing({ target: users.workosUserId })
    .returning({ id: users.id })

  // Only the request that actually created the row writes the grant. Under a
  // concurrent first request the loser's insert is a no-op and returns nothing,
  // so the grant cannot be written twice.
  if (inserted.length > 0) {
    await db.insert(creditLedger).values({
      id: `led_${crypto.randomUUID()}`,
      userId: inserted[0].id,
      delta: INITIAL_CREDIT_GRANT,
      feature: 'signup_grant',
      reason: 'Initial credit grant on first sign-in',
    })
  }

  // Re-read rather than trusting the insert: under a concurrent first request
  // the conflict path leaves us without a returned row.
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.workosUserId, workosUserId))
    .limit(1)

  return {
    id: row.id,
    workosUserId: row.workosUserId,
    email: row.email,
    creditBalance: row.creditBalance,
  }
}
