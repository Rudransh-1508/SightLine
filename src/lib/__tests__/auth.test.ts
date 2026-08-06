import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

import { createTestDb, type TestDb } from '@/db/__tests__/helpers'
import { users, creditLedger } from '@/db/schema'

/**
 * Auth tests run entirely against PGlite with WorkOS mocked. Nothing here
 * touches the network, so the suite stays free and hermetic.
 */

let db: TestDb

// `withAuth` is what actually verifies the session. Mocking it lets us drive
// the signed-in / signed-out branches without a real WorkOS round trip.
const withAuth = vi.hoisted(() => vi.fn())
vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth }))
vi.mock('server-only', () => ({}))
vi.mock('@/db/client', () => ({
  get db() {
    return currentDb
  },
}))

let currentDb: TestDb

beforeEach(async () => {
  vi.clearAllMocks()
  ;({ db } = await createTestDb())
  currentDb = db
})

async function importAuth() {
  return import('../auth')
}

describe('requireUser', () => {
  it('throws when there is no session', async () => {
    withAuth.mockRejectedValueOnce(new Error('No session'))
    const { requireUser } = await importAuth()
    await expect(requireUser()).rejects.toThrow(/no session/i)
  })

  it('returns the provisioned user when signed in', async () => {
    withAuth.mockResolvedValueOnce({ user: { id: 'wu_1', email: 'a@b.c' } })
    const { requireUser } = await importAuth()
    const user = await requireUser()
    expect(user.workosUserId).toBe('wu_1')
    expect(user.email).toBe('a@b.c')
  })

  it('asks WorkOS to enforce sign-in rather than checking a flag itself', async () => {
    withAuth.mockResolvedValueOnce({ user: { id: 'wu_1', email: 'a@b.c' } })
    const { requireUser } = await importAuth()
    await requireUser()
    expect(withAuth).toHaveBeenCalledWith({ ensureSignedIn: true })
  })
})

describe('getOptionalUser', () => {
  it('returns null when signed out, without throwing', async () => {
    withAuth.mockResolvedValueOnce({ user: null })
    const { getOptionalUser } = await importAuth()
    expect(await getOptionalUser()).toBeNull()
  })

  it('does not force sign-in', async () => {
    withAuth.mockResolvedValueOnce({ user: null })
    const { getOptionalUser } = await importAuth()
    await getOptionalUser()
    expect(withAuth).toHaveBeenCalledWith()
  })
})

describe('provisionUser', () => {
  it('creates a user with the initial credit grant', async () => {
    const { provisionUser, INITIAL_CREDIT_GRANT } = await importAuth()
    const user = await provisionUser('wu_new', 'new@example.com')
    expect(user.creditBalance).toBe(INITIAL_CREDIT_GRANT)

    const rows = await db.select().from(users)
    expect(rows).toHaveLength(1)
  })

  /**
   * The balance column is a derived cache; credit_ledger is authoritative. If
   * provisioning only wrote the column the two would disagree from the very
   * first row, and every later balance check would be reconciling a lie.
   */
  it('records the grant in the ledger, not only the balance column', async () => {
    const { provisionUser, INITIAL_CREDIT_GRANT } = await importAuth()
    const user = await provisionUser('wu_led', 'led@example.com')

    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.userId, user.id))

    expect(ledger).toHaveLength(1)
    expect(ledger[0].delta).toBe(INITIAL_CREDIT_GRANT)
    expect(ledger.reduce((sum, r) => sum + r.delta, 0)).toBe(user.creditBalance)
  })

  it('is idempotent — a returning user is not re-provisioned', async () => {
    const { provisionUser } = await importAuth()
    const first = await provisionUser('wu_same', 'same@example.com')
    const second = await provisionUser('wu_same', 'same@example.com')

    expect(second.id).toBe(first.id)
    expect(await db.select().from(users)).toHaveLength(1)
  })

  it('does not grant credits twice to a returning user', async () => {
    const { provisionUser, INITIAL_CREDIT_GRANT } = await importAuth()
    await provisionUser('wu_twice', 'twice@example.com')
    await provisionUser('wu_twice', 'twice@example.com')
    await provisionUser('wu_twice', 'twice@example.com')

    const ledger = await db.select().from(creditLedger)
    expect(ledger).toHaveLength(1)
    expect(ledger[0].delta).toBe(INITIAL_CREDIT_GRANT)
  })

  it('does not double-grant when two first requests race', async () => {
    const { provisionUser, INITIAL_CREDIT_GRANT } = await importAuth()
    await Promise.all([
      provisionUser('wu_race', 'race@example.com'),
      provisionUser('wu_race', 'race@example.com'),
    ])

    expect(await db.select().from(users)).toHaveLength(1)
    const ledger = await db.select().from(creditLedger)
    expect(ledger.reduce((sum, r) => sum + r.delta, 0)).toBe(INITIAL_CREDIT_GRANT)
  })

  it('keeps separate users separate', async () => {
    const { provisionUser } = await importAuth()
    const a = await provisionUser('wu_a', 'a@example.com')
    const b = await provisionUser('wu_b', 'b@example.com')

    expect(a.id).not.toBe(b.id)
    expect(await db.select().from(users)).toHaveLength(2)
  })
})
