import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createTestDb, type TestDb } from '@/db/__tests__/helpers'
import { datasets, nodes, edges, revisions } from '@/db/schema'

let db: TestDb
let currentDb: TestDb

vi.mock('@/db/client', () => ({
  get db() {
    return currentDb
  },
}))

const DATASET = 'live'
const EDGE_ID = 'edge_1'

async function graphDb() {
  return import('../graph-db')
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
  currentDb = db

  await db
    .insert(datasets)
    .values({ id: DATASET, slug: DATASET, name: 'Live', kind: 'sourced' })
  await db.insert(nodes).values([
    {
      id: 'repsol',
      datasetId: DATASET,
      name: 'Repsol',
      category: 'client',
      country: 'ES',
      region: 'Iberia',
      influence: 100,
      role: 'client',
      description: 'd',
    },
    {
      id: 'sonatrach',
      datasetId: DATASET,
      name: 'Sonatrach',
      category: 'supplier',
      country: 'DZ',
      region: 'North Africa',
      influence: 80,
      role: 'supplier',
      description: 'd',
    },
  ])
  await db.insert(edges).values({
    id: EDGE_ID,
    datasetId: DATASET,
    sourceId: 'repsol',
    targetId: 'sonatrach',
    type: 'contractual',
    direction: 'source-depends',
    strength: 85,
    state: 'strained',
    trajectory: 'improving',
    exposure: 'gas supply',
    since: 2010,
    lastEventDate: '2026-01',
    lastEventSummary: 'price review',
    narrative: 'n',
    confidence: 'high',
  })
})

/**
 * The copilot's get_timeline tool identifies a relationship by its logical key
 * (source, target, type) — the same key the renderer and the citations use —
 * because RelationshipEdge deliberately carries no surrogate id. This is the
 * translation to the row id, which never leaves graph-db.
 */
describe('edgeRevisions', () => {
  async function addRevision(field: string, appliedAt: Date, entityId = EDGE_ID) {
    await db.insert(revisions).values({
      id: `rev_${field}_${appliedAt.getTime()}`,
      entityType: 'edge',
      entityId,
      field,
      oldValue: 'stable',
      newValue: 'strained',
      appliedAt,
    })
  }

  it('returns the history of one relationship, newest first', async () => {
    const { edgeRevisions } = await graphDb()
    await addRevision('state', new Date('2026-01-01'))
    await addRevision('trajectory', new Date('2026-06-01'))

    const history = await edgeRevisions(DATASET, 'repsol', 'sonatrach', 'contractual')

    expect(history.map((h) => h.field)).toEqual(['trajectory', 'state'])
    expect(history[0]).toMatchObject({ oldValue: 'stable', newValue: 'strained' })
  })

  it('returns nothing for a relationship that does not exist', async () => {
    const { edgeRevisions } = await graphDb()
    await addRevision('state', new Date('2026-01-01'))

    // Same pair, different type — a distinct relationship.
    expect(await edgeRevisions(DATASET, 'repsol', 'sonatrach', 'equity')).toEqual([])
    expect(await edgeRevisions(DATASET, 'sonatrach', 'repsol', 'contractual')).toEqual([])
  })

  it('returns nothing for an unknown dataset', async () => {
    const { edgeRevisions } = await graphDb()
    expect(await edgeRevisions('nope', 'repsol', 'sonatrach', 'contractual')).toEqual([])
  })

  it('returns an empty history rather than failing when nothing has changed', async () => {
    const { edgeRevisions } = await graphDb()
    expect(await edgeRevisions(DATASET, 'repsol', 'sonatrach', 'contractual')).toEqual([])
  })

  /** Node revisions share the table; an edge lookup must not pick them up. */
  it('does not return revisions belonging to a node', async () => {
    const { edgeRevisions } = await graphDb()
    await db.insert(revisions).values({
      id: 'rev_node',
      entityType: 'node',
      entityId: EDGE_ID,
      field: 'created',
      oldValue: null,
      newValue: 'Repsol',
      appliedAt: new Date('2026-02-01'),
    })

    expect(await edgeRevisions(DATASET, 'repsol', 'sonatrach', 'contractual')).toEqual([])
  })
})
