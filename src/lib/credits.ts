import { eq, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import { creditLedger, users } from '@/db/schema'

/**
 * Credit metering for AI features.
 *
 * Mirrors the cost table in CLAUDE.md, which is the single source of truth.
 * Anything that does not call a model costs nothing and must never be routed
 * through here — the deterministic ingestion prefilter and all graph analytics
 * included. A user with no credits still gets the full visualisation and every
 * structural insight; only generation and extraction stop.
 */
export const CREDIT_COSTS = {
  /** One batched triage call covering ~20 documents, not one per document. */
  triage_batch: 1,
  extract_document: 5,
  copilot_simple: 3,
  copilot_complex: 5,
  briefing_weekly: 15,
  extract_retry: 5,
} as const

export type MeteredFeature = keyof typeof CREDIT_COSTS

export class InsufficientCreditsError extends Error {
  readonly status = 402
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`Insufficient credits: need ${required}, have ${available}`)
    this.name = 'InsufficientCreditsError'
  }
}

/** Rows returned by db.execute differ by driver; normalise them. */
function resultRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows
    return Array.isArray(rows) ? rows : []
  }
  return []
}

/**
 * Authoritative balance, summed from the append-only ledger.
 *
 * `users.credit_balance` is a derived cache for cheap display and is never
 * consulted here — if the two ever disagree, the ledger is right.
 */
export async function getBalance(userId: string): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`coalesce(sum(${creditLedger.delta}), 0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.userId, userId))
  return row?.balance ?? 0
}

async function syncBalanceCache(userId: string): Promise<number> {
  const balance = await getBalance(userId)
  await db.update(users).set({ creditBalance: balance }).where(eq(users.id, userId))
  return balance
}

export interface Reservation {
  id: string
  feature: MeteredFeature
  cost: number
  userId: string
}

/**
 * Reserves credits, or throws `InsufficientCreditsError`.
 *
 * The check and the deduction are a SINGLE statement — an `INSERT ... SELECT`
 * guarded by a `WHERE` over the ledger sum. Reading the balance and then
 * inserting would be a race: two concurrent requests could both observe enough
 * credit and both spend it, driving the balance negative. Here the database
 * evaluates the guard and the write atomically, so the loser simply inserts no
 * row.
 */
export async function reserve(
  userId: string,
  feature: MeteredFeature,
  refId?: string,
): Promise<Reservation> {
  const cost = CREDIT_COSTS[feature]
  const id = `led_${crypto.randomUUID()}`

  const result = await db.execute(sql`
    insert into credit_ledger (id, user_id, delta, feature, ref_id, reason)
    select ${id}, ${userId}, ${-cost}, ${feature}, ${refId ?? null}, 'reserve'
    where (
      select coalesce(sum(delta), 0) from credit_ledger where user_id = ${userId}
    ) >= ${cost}
    returning id
  `)

  if (resultRows(result).length === 0) {
    throw new InsufficientCreditsError(cost, await getBalance(userId))
  }

  await syncBalanceCache(userId)
  return { id, feature, cost, userId }
}

/**
 * Returns reserved credits after a failed call.
 *
 * Compensating entry rather than a delete: the ledger is append-only, so a
 * refunded charge stays visible as a charge and a refund. Refunding twice is a
 * no-op — the guard checks for an existing refund referencing this reservation.
 */
export async function refund(reservation: Reservation, reason = 'refund'): Promise<void> {
  const result = await db.execute(sql`
    insert into credit_ledger (id, user_id, delta, feature, ref_id, reason)
    select ${`led_${crypto.randomUUID()}`}, ${reservation.userId}, ${reservation.cost},
           ${reservation.feature}, ${reservation.id}, ${reason}
    where not exists (
      select 1 from credit_ledger where ref_id = ${reservation.id} and delta > 0
    )
    returning id
  `)

  if (resultRows(result).length > 0) {
    await syncBalanceCache(reservation.userId)
  }
}

/**
 * Adjusts a reservation down to what the work actually cost.
 *
 * The copilot cannot know its own price in advance: per the cost table a
 * question is 3 credits at up to two tool calls and 5 beyond that, and which
 * one it is only becomes known once the model has stopped calling tools. So the
 * route reserves the HIGHER price up front and settles down here. Reserving the
 * lower price and topping up later would let a caller with 3 credits start a
 * path-finding question and finish it unpaid — the rule in CLAUDE.md is that
 * the balance is checked *before* the provider is contacted, and that only
 * holds if the amount checked is the worst case.
 *
 * Returns the credits given back. Settling twice is a no-op, like refund.
 */
export async function settle(
  reservation: Reservation,
  actualFeature: MeteredFeature,
): Promise<number> {
  const actualCost = CREDIT_COSTS[actualFeature]
  if (actualCost > reservation.cost) {
    throw new Error(
      `Cannot settle ${reservation.feature} (${reservation.cost}) up to ` +
        `${actualFeature} (${actualCost}) — reserve the higher cost instead.`,
    )
  }

  const rebate = reservation.cost - actualCost
  if (rebate === 0) return 0

  const result = await db.execute(sql`
    insert into credit_ledger (id, user_id, delta, feature, ref_id, reason)
    select ${`led_${crypto.randomUUID()}`}, ${reservation.userId}, ${rebate},
           ${actualFeature}, ${reservation.id}, ${`settle: charged ${actualCost}`}
    where not exists (
      select 1 from credit_ledger where ref_id = ${reservation.id} and delta > 0
    )
    returning id
  `)

  if (resultRows(result).length === 0) return 0
  await syncBalanceCache(reservation.userId)
  return rebate
}

/**
 * Runs metered work, refunding automatically if it throws.
 *
 * Credits are reserved BEFORE `work` runs, so a caller without balance never
 * reaches the provider — the 402 is raised without any model call being made.
 */
export async function withCredits<T>(
  userId: string,
  feature: MeteredFeature,
  work: () => Promise<T>,
  refId?: string,
): Promise<T> {
  const reservation = await reserve(userId, feature, refId)
  try {
    return await work()
  } catch (err) {
    await refund(reservation, 'refund: work failed')
    throw err
  }
}

/** Grants credits (top-up, promo, manual adjustment). */
export async function grant(userId: string, amount: number, reason = 'grant'): Promise<number> {
  if (amount <= 0) throw new Error('grant amount must be positive')
  await db.insert(creditLedger).values({
    id: `led_${crypto.randomUUID()}`,
    userId,
    delta: amount,
    feature: 'grant',
    reason,
  })
  return syncBalanceCache(userId)
}
