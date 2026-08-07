import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

import { createTestDb, type TestDb } from '@/db/__tests__/helpers'
import { users, creditLedger } from '@/db/schema'

let db: TestDb
let currentDb: TestDb

vi.mock('@/db/client', () => ({
  get db() {
    return currentDb
  },
}))

const USER = 'u1'

beforeEach(async () => {
  ;({ db } = await createTestDb())
  currentDb = db
  await db.insert(users).values({
    id: USER,
    workosUserId: 'w1',
    email: 'a@b.c',
    creditBalance: 0,
  })
})

async function credits() {
  return import('../credits')
}

/**
 * The cost table lives in CLAUDE.md and is the source of truth. These assert
 * the code matches it, so changing one without the other is caught here rather
 * than discovered as a billing discrepancy.
 */
describe('cost table', () => {
  it('matches the documented costs', async () => {
    const { CREDIT_COSTS } = await credits()
    expect(CREDIT_COSTS).toEqual({
      triage_batch: 1,
      extract_document: 5,
      copilot_simple: 3,
      copilot_complex: 5,
      briefing_weekly: 15,
      extract_retry: 5,
    })
  })

  it('prices triage per batch, not per document', async () => {
    const { CREDIT_COSTS } = await credits()
    // ~20 documents per call. Per-document pricing would misstate cost ~20x
    // and create an incentive against the batching the design depends on.
    expect(CREDIT_COSTS.triage_batch).toBe(1)
    expect(CREDIT_COSTS.triage_batch).toBeLessThan(CREDIT_COSTS.extract_document)
  })
})

describe('getBalance', () => {
  it('is zero for a user with no ledger entries', async () => {
    const { getBalance } = await credits()
    expect(await getBalance(USER)).toBe(0)
  })

  it('sums signed deltas', async () => {
    const { getBalance } = await credits()
    await db.insert(creditLedger).values([
      { id: 'l1', userId: USER, delta: 100, feature: 'grant' },
      { id: 'l2', userId: USER, delta: -5, feature: 'extract_document' },
    ])
    expect(await getBalance(USER)).toBe(95)
  })
})

describe('reserve', () => {
  it('deducts the feature cost', async () => {
    const { grant, reserve, getBalance } = await credits()
    await grant(USER, 20)
    await reserve(USER, 'extract_document')
    expect(await getBalance(USER)).toBe(15)
  })

  it('throws InsufficientCreditsError when short', async () => {
    const { grant, reserve, InsufficientCreditsError } = await credits()
    await grant(USER, 2)
    await expect(reserve(USER, 'extract_document')).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    )
  })

  it('carries a 402 status for the route layer', async () => {
    const { reserve } = await credits()
    await reserve(USER, 'triage_batch').catch((e) => {
      expect(e.status).toBe(402)
      expect(e.required).toBe(1)
      expect(e.available).toBe(0)
    })
    expect.assertions(3)
  })

  it('writes nothing to the ledger when it fails', async () => {
    const { reserve } = await credits()
    await reserve(USER, 'briefing_weekly').catch(() => {})
    expect(await db.select().from(creditLedger)).toHaveLength(0)
  })

  it('allows spending down to exactly zero', async () => {
    const { grant, reserve, getBalance } = await credits()
    await grant(USER, 5)
    await reserve(USER, 'extract_document')
    expect(await getBalance(USER)).toBe(0)
  })

  /**
   * The reserve is a single guarded INSERT precisely so this cannot happen.
   * A read-then-write implementation would let both calls observe enough
   * credit and both spend it.
   */
  it('never lets the balance go negative under repeated spending', async () => {
    const { grant, reserve, getBalance } = await credits()
    await grant(USER, 12)

    let succeeded = 0
    for (let i = 0; i < 10; i++) {
      try {
        await reserve(USER, 'extract_document')
        succeeded++
      } catch {
        /* expected once exhausted */
      }
    }

    expect(succeeded).toBe(2) // 12 credits / 5 each
    expect(await getBalance(USER)).toBe(2)
    expect(await getBalance(USER)).toBeGreaterThanOrEqual(0)
  })

  it('keeps the cached balance column in step with the ledger', async () => {
    const { grant, reserve, getBalance } = await credits()
    await grant(USER, 30)
    await reserve(USER, 'copilot_simple')

    const [row] = await db.select().from(users).where(eq(users.id, USER))
    expect(row.creditBalance).toBe(await getBalance(USER))
  })
})

describe('refund', () => {
  it('restores the reserved amount', async () => {
    const { grant, reserve, refund, getBalance } = await credits()
    await grant(USER, 20)
    const r = await reserve(USER, 'extract_document')
    expect(await getBalance(USER)).toBe(15)
    await refund(r)
    expect(await getBalance(USER)).toBe(20)
  })

  it('is append-only — the original charge stays visible', async () => {
    const { grant, reserve, refund } = await credits()
    await grant(USER, 20)
    const r = await reserve(USER, 'extract_document')
    await refund(r)

    const rows = await db.select().from(creditLedger)
    expect(rows.filter((x) => x.delta < 0)).toHaveLength(1)
    expect(rows.filter((x) => x.delta > 0)).toHaveLength(2) // grant + refund
  })

  it('cannot be applied twice', async () => {
    const { grant, reserve, refund, getBalance } = await credits()
    await grant(USER, 20)
    const r = await reserve(USER, 'extract_document')
    await refund(r)
    await refund(r)
    await refund(r)
    expect(await getBalance(USER)).toBe(20)
  })
})

describe('withCredits', () => {
  it('runs the work and keeps the charge on success', async () => {
    const { grant, withCredits, getBalance } = await credits()
    await grant(USER, 20)
    const work = vi.fn().mockResolvedValue('done')

    const result = await withCredits(USER, 'extract_document', work)

    expect(result).toBe('done')
    expect(work).toHaveBeenCalledOnce()
    expect(await getBalance(USER)).toBe(15)
  })

  /**
   * The most important test in this file: a caller without credits must never
   * reach the provider. If this regresses, the 402 arrives *after* the tokens
   * were already spent.
   */
  it('never invokes the work when credits are insufficient', async () => {
    const { withCredits, InsufficientCreditsError } = await credits()
    const work = vi.fn().mockResolvedValue('should not run')

    await expect(withCredits(USER, 'briefing_weekly', work)).rejects.toBeInstanceOf(
      InsufficientCreditsError,
    )
    expect(work).not.toHaveBeenCalled()
  })

  it('refunds when the work throws', async () => {
    const { grant, withCredits, getBalance } = await credits()
    await grant(USER, 20)
    const work = vi.fn().mockRejectedValue(new Error('provider exploded'))

    await expect(withCredits(USER, 'extract_document', work)).rejects.toThrow(
      /provider exploded/,
    )
    expect(await getBalance(USER)).toBe(20)
  })

  it('propagates the original error, not a billing error', async () => {
    const { grant, withCredits } = await credits()
    await grant(USER, 20)
    const work = vi.fn().mockRejectedValue(new Error('rate limited'))

    await expect(withCredits(USER, 'extract_document', work)).rejects.toThrow(/rate limited/)
  })
})

/**
 * The copilot's price is only known after the answer: 3 credits up to two tool
 * calls, 5 beyond. The route reserves the worst case and settles down, so a
 * caller with 3 credits cannot start a 5-credit question.
 */
describe('settle', () => {
  it('refunds the difference when the work turned out cheaper', async () => {
    const { grant, reserve, settle, getBalance } = await credits()
    await grant(USER, 10)
    const reservation = await reserve(USER, 'copilot_complex')
    expect(await getBalance(USER)).toBe(5)

    const rebate = await settle(reservation, 'copilot_simple')

    expect(rebate).toBe(2)
    expect(await getBalance(USER)).toBe(7)
  })

  it('writes nothing when the reserved price was the actual price', async () => {
    const { grant, reserve, settle, getBalance } = await credits()
    await grant(USER, 10)
    const reservation = await reserve(USER, 'copilot_complex')

    expect(await settle(reservation, 'copilot_complex')).toBe(0)
    expect(await getBalance(USER)).toBe(5)
    expect(
      await db.select().from(creditLedger).where(eq(creditLedger.userId, USER)),
    ).toHaveLength(2)
  })

  it('refuses to settle upwards — the reservation must be the worst case', async () => {
    const { grant, reserve, settle } = await credits()
    await grant(USER, 10)
    const reservation = await reserve(USER, 'copilot_simple')

    await expect(settle(reservation, 'copilot_complex')).rejects.toThrow(
      /reserve the higher cost/,
    )
  })

  it('is idempotent — settling twice does not pay the rebate twice', async () => {
    const { grant, reserve, settle, getBalance } = await credits()
    await grant(USER, 10)
    const reservation = await reserve(USER, 'copilot_complex')

    await settle(reservation, 'copilot_simple')
    await settle(reservation, 'copilot_simple')

    expect(await getBalance(USER)).toBe(7)
  })

  /** A settled call is already paid for; a later refund must not undo the charge. */
  it('cannot be refunded after settling', async () => {
    const { grant, reserve, settle, refund, getBalance } = await credits()
    await grant(USER, 10)
    const reservation = await reserve(USER, 'copilot_complex')

    await settle(reservation, 'copilot_simple')
    await refund(reservation)

    expect(await getBalance(USER)).toBe(7)
  })

  it('keeps the whole history visible in the append-only ledger', async () => {
    const { grant, reserve, settle } = await credits()
    await grant(USER, 10)
    const reservation = await reserve(USER, 'copilot_complex')
    await settle(reservation, 'copilot_simple')

    const rows = await db.select().from(creditLedger).where(eq(creditLedger.userId, USER))
    expect(rows.map((r) => r.delta).sort((a, b) => a - b)).toEqual([-5, 2, 10])
  })
})

describe('grant', () => {
  it('rejects a non-positive amount', async () => {
    const { grant } = await credits()
    await expect(grant(USER, 0)).rejects.toThrow(/positive/)
    await expect(grant(USER, -5)).rejects.toThrow(/positive/)
  })
})
