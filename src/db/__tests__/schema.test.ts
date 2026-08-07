import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

import { createTestDb, dbErrorMessage, type TestDb } from './helpers'
import { datasets, nodes, edges, proposals, users, creditLedger } from '../schema'
import {
  CATEGORIES,
  REGIONS,
  REL_STATES,
  TRAJECTORIES,
  REL_TYPES,
  DIRECTIONS,
  CONFIDENCES,
} from '@/lib/types'

let db: TestDb

const DEMO = 'repsol-demo'
const LIVE = 'live'

async function seedDatasets(d: TestDb) {
  await d.insert(datasets).values([
    { id: DEMO, slug: DEMO, name: 'Demo', kind: 'illustrative' },
    { id: LIVE, slug: LIVE, name: 'Live', kind: 'sourced' },
  ])
}

async function addNode(d: TestDb, datasetId: string, id: string, over = {}) {
  await d.insert(nodes).values({
    id,
    datasetId,
    name: id,
    category: 'supplier',
    country: 'ES',
    region: 'Iberia',
    influence: 50,
    role: 'r',
    description: 'd',
    keyPeople: [],
    ...over,
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

/**
 * The core invariant from the design: the illustrative demo dataset cannot be
 * targeted by a proposal, and that is enforced by Postgres rather than by
 * application discipline. These are the most important tests in the project.
 */
describe('demo dataset is unproposable', () => {
  beforeEach(() => seedDatasets(db))

  it('rejects a proposal targeting the illustrative dataset', async () => {
    expect(
      await dbErrorMessage(() =>
        db.insert(proposals).values({
          id: 'p1',
          datasetId: DEMO,
          kind: 'edge_update',
          payload: {},
        }),
      ),
    ).toMatch(/foreign key|proposals_dataset_fk/i)
  })

  it('accepts a proposal targeting a sourced dataset', async () => {
    await db
      .insert(proposals)
      .values({ id: 'p2', datasetId: LIVE, kind: 'edge_update', payload: {} })
    const rows = await db.select().from(proposals)
    expect(rows).toHaveLength(1)
  })

  it('rejects an attempt to force dataset_kind to illustrative', async () => {
    expect(
      await dbErrorMessage(() =>
        db.insert(proposals).values({
          id: 'p3',
          datasetId: DEMO,
          datasetKind: 'illustrative',
          kind: 'edge_update',
          payload: {},
        }),
      ),
    ).toMatch(/check constraint|proposals_sourced_only/i)
  })

  it('defaults new proposals to sourced', async () => {
    await db
      .insert(proposals)
      .values({ id: 'p4', datasetId: LIVE, kind: 'node_create', payload: {} })
    const [row] = await db.select().from(proposals).where(eq(proposals.id, 'p4'))
    expect(row.datasetKind).toBe('sourced')
    expect(row.status).toBe('pending')
  })
})

describe('graph constraints', () => {
  beforeEach(async () => {
    await seedDatasets(db)
    await addNode(db, DEMO, 'a')
    await addNode(db, DEMO, 'b')
  })

  it('rejects influence outside 0-100', async () => {
    expect(await dbErrorMessage(() => addNode(db, DEMO, 'bad', { influence: 101 }))).toMatch(
      /check constraint|influence_range/i,
    )
  })

  it('rejects a self-loop edge', async () => {
    expect(
      await dbErrorMessage(() =>
        db.insert(edges).values({
          id: 'e-self',
          datasetId: DEMO,
          sourceId: 'a',
          targetId: 'a',
          type: 'equity',
          direction: 'mutual',
          strength: 10,
          state: 'stable',
          trajectory: 'stable',
          exposure: 'x',
          since: 2000,
          lastEventDate: '2026-01',
          lastEventSummary: 's',
          narrative: 'n',
          confidence: 'high',
        }),
      ),
    ).toMatch(/check constraint|no_self_loop/i)
  })

  it('allows two edges between the same pair with different types', async () => {
    const base = {
      datasetId: DEMO,
      sourceId: 'a',
      targetId: 'b',
      direction: 'mutual' as const,
      strength: 10,
      state: 'stable' as const,
      trajectory: 'stable' as const,
      exposure: 'x',
      since: 2000,
      lastEventDate: '2026-01',
      lastEventSummary: 's',
      narrative: 'n',
      confidence: 'high' as const,
    }
    await db.insert(edges).values({ ...base, id: 'e1', type: 'equity' })
    await db.insert(edges).values({ ...base, id: 'e2', type: 'adversarial' })
    expect(await db.select().from(edges)).toHaveLength(2)
  })

  it('rejects a duplicate edge of the same type between the same pair', async () => {
    const base = {
      datasetId: DEMO,
      sourceId: 'a',
      targetId: 'b',
      type: 'equity' as const,
      direction: 'mutual' as const,
      strength: 10,
      state: 'stable' as const,
      trajectory: 'stable' as const,
      exposure: 'x',
      since: 2000,
      lastEventDate: '2026-01',
      lastEventSummary: 's',
      narrative: 'n',
      confidence: 'high' as const,
    }
    await db.insert(edges).values({ ...base, id: 'e1' })
    expect(await dbErrorMessage(() => db.insert(edges).values({ ...base, id: 'e2' }))).toMatch(
      /unique|edges_unique_rel/i,
    )
  })

  it('rejects an edge pointing at a node in another dataset', async () => {
    await addNode(db, LIVE, 'other')
    expect(
      await dbErrorMessage(() =>
        db.insert(edges).values({
          id: 'e-cross',
          datasetId: DEMO,
          sourceId: 'a',
          targetId: 'other',
          type: 'equity',
          direction: 'mutual',
          strength: 10,
          state: 'stable',
          trajectory: 'stable',
          exposure: 'x',
          since: 2000,
          lastEventDate: '2026-01',
          lastEventSummary: 's',
          narrative: 'n',
          confidence: 'high',
        }),
      ),
    ).toMatch(/foreign key/i)
  })

  it('lets the same node id exist in both datasets independently', async () => {
    await addNode(db, LIVE, 'a')
    const rows = await db.select().from(nodes).where(eq(nodes.id, 'a'))
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.datasetId))).toEqual(new Set([DEMO, LIVE]))
  })
})

/**
 * The database enums are generated from the unions in types.ts. If someone adds
 * a union member without regenerating the migration, these fail — which is the
 * drift the generation was meant to prevent.
 */
describe('enums match types.ts', () => {
  beforeEach(async () => {
    await seedDatasets(db)
  })

  it.each(CATEGORIES)('accepts category %s', async (category) => {
    await addNode(db, DEMO, `n-${category}`, { category })
    const [row] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, `n-${category}`))
    expect(row.category).toBe(category)
  })

  it.each(REGIONS)('accepts region %s', async (region) => {
    await addNode(db, DEMO, `n-${region}`, { region })
    const [row] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, `n-${region}`))
    expect(row.region).toBe(region)
  })

  it('rejects a category that is not in the union', async () => {
    // Cast rather than @ts-expect-error: the value is deliberately outside the
    // union, and the point is that the *database* rejects it, not the compiler.
    const invalid = { category: 'not-a-category' } as unknown as { category: never }
    expect(await dbErrorMessage(() => addNode(db, DEMO, 'bad', invalid))).toBeTruthy()
  })

  /**
   * Each edge enum is exercised separately rather than through one generic
   * loop. A dynamic `{ [field]: value }` spread reads cleverly but collides
   * with the fixed `type` key, and TypeScript rightly rejects it — the explicit
   * version is longer and actually type-safe.
   *
   * The unique index covers (dataset, source, target, type), so each insert
   * varies `type` to stay distinct while the field under test cycles.
   */
  function edgeWith(i: number, over: Partial<typeof edges.$inferInsert>) {
    return {
      id: `e-${i}-${String(Object.keys(over)[0] ?? 'base')}`,
      datasetId: DEMO,
      sourceId: 'x',
      targetId: 'y',
      type: REL_TYPES[i % REL_TYPES.length],
      direction: 'mutual' as const,
      strength: 10,
      state: 'stable' as const,
      trajectory: 'stable' as const,
      exposure: 'x',
      since: 2000,
      lastEventDate: '2026-01',
      lastEventSummary: 's',
      narrative: 'n',
      confidence: 'high' as const,
      ...over,
    }
  }

  beforeEach(async () => {
    await addNode(db, DEMO, 'x')
    await addNode(db, DEMO, 'y')
  })

  it('round-trips every relationship state', async () => {
    for (const [i, state] of REL_STATES.entries()) {
      await db.insert(edges).values(edgeWith(i, { state }))
    }
    expect(await db.select().from(edges)).toHaveLength(REL_STATES.length)
  })

  it('round-trips every trajectory', async () => {
    for (const [i, trajectory] of TRAJECTORIES.entries()) {
      await db.insert(edges).values(edgeWith(i, { trajectory }))
    }
    expect(await db.select().from(edges)).toHaveLength(TRAJECTORIES.length)
  })

  it('round-trips every relationship type', async () => {
    for (const [i, type] of REL_TYPES.entries()) {
      await db.insert(edges).values(edgeWith(i, { type }))
    }
    expect(await db.select().from(edges)).toHaveLength(REL_TYPES.length)
  })

  it('round-trips every direction', async () => {
    for (const [i, direction] of DIRECTIONS.entries()) {
      await db.insert(edges).values(edgeWith(i, { direction }))
    }
    expect(await db.select().from(edges)).toHaveLength(DIRECTIONS.length)
  })

  it('round-trips every confidence level', async () => {
    for (const [i, confidence] of CONFIDENCES.entries()) {
      await db.insert(edges).values(edgeWith(i, { confidence }))
    }
    expect(await db.select().from(edges)).toHaveLength(CONFIDENCES.length)
  })
})

describe('credit ledger', () => {
  beforeEach(async () => {
    await db.insert(users).values({ id: 'u1', workosUserId: 'w1', email: 'a@b.c' })
  })

  it('stores signed deltas as an append-only log', async () => {
    await db.insert(creditLedger).values([
      { id: 'l1', userId: 'u1', delta: 100, feature: 'grant' },
      { id: 'l2', userId: 'u1', delta: -5, feature: 'extract' },
    ])
    const rows = await db.select().from(creditLedger)
    expect(rows.reduce((sum, r) => sum + r.delta, 0)).toBe(95)
  })

  it('rejects a duplicate workos user id', async () => {
    expect(
      await dbErrorMessage(() =>
        db.insert(users).values({ id: 'u2', workosUserId: 'w1', email: 'x@y.z' }),
      ),
    ).toMatch(/unique/i)
  })
})
