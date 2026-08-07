import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

import { createTestDb, dbErrorMessage, type TestDb } from '@/db/__tests__/helpers'
import { datasets, nodes, edges, proposals, sources } from '@/db/schema'
import type { EntityIndexEntry } from '../prefilter'
import type { ExtractionResponse } from '../schemas'

let db: TestDb
let currentDb: TestDb

vi.mock('@/db/client', () => ({
  get db() {
    return currentDb
  },
}))

const LIVE = 'live'
const DEMO = 'repsol-demo'

const INDEX: EntityIndexEntry[] = [
  { nodeId: 'repsol', matchers: ['Repsol'] },
  { nodeId: 'sonatrach', matchers: ['Sonatrach'] },
]

function extraction(over: Partial<ExtractionResponse> = {}): ExtractionResponse {
  return {
    found: true,
    sourceEntity: 'Repsol',
    targetEntity: 'Sonatrach',
    relationshipType: 'contractual',
    direction: 'source-depends',
    strength: 70,
    state: 'strained',
    trajectory: 'improving',
    exposure: 'gas supply',
    narrative: 'Price terms narrowed.',
    confidence: 'medium',
    evidenceQuote: 'a verbatim quote',
    ...over,
  }
}

async function addNode(datasetId: string, id: string, name: string) {
  await db.insert(nodes).values({
    id,
    datasetId,
    name,
    category: 'supplier',
    country: 'ES',
    region: 'Iberia',
    influence: 50,
    role: 'r',
    description: 'd',
    keyPeople: [],
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
  currentDb = db
  await db.insert(datasets).values([
    { id: LIVE, slug: LIVE, name: 'Live', kind: 'sourced' },
    { id: DEMO, slug: DEMO, name: 'Demo', kind: 'illustrative' },
  ])
  await db.insert(nodes).values(
    [
      ['repsol', 'Repsol'],
      ['sonatrach', 'Sonatrach'],
    ].map(([id, name]) => ({
      id,
      datasetId: LIVE,
      name,
      category: 'supplier' as const,
      country: 'ES',
      region: 'Iberia' as const,
      influence: 50,
      role: 'r',
      description: 'd',
      keyPeople: [],
    })),
  )
  await db
    .insert(sources)
    .values({ id: 'src1', url: 'https://x', publisher: 'p', contentHash: 'h1' })
})

async function stage() {
  return import('../stage')
}

describe('stageExtraction — not found / incomplete', () => {
  it('writes nothing when the extraction found nothing', async () => {
    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: 'irrelevant body',
      extraction: extraction({ found: false, sourceEntity: null, targetEntity: null }),
      model: 'm',
      entityIndex: INDEX,
    })
    expect(result).toEqual({ proposalId: null, status: null, reason: 'no_relationship_found' })
    expect(await db.select().from(proposals)).toHaveLength(0)
  })

  it('writes nothing when an entity name is missing despite found=true', async () => {
    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: 'a verbatim quote appears here',
      extraction: extraction({ sourceEntity: null }),
      model: 'm',
      entityIndex: INDEX,
    })
    expect(result.reason).toBe('missing_entity_name')
    expect(await db.select().from(proposals)).toHaveLength(0)
  })
})

describe('stageExtraction — evidence check', () => {
  it('auto-rejects but still writes a proposal when the quote is fabricated', async () => {
    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: 'This body does not contain that quote at all.',
      extraction: extraction(),
      model: 'm',
      entityIndex: INDEX,
    })
    expect(result.status).toBe('auto_rejected')
    expect(result.proposalId).toBeTruthy()

    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.proposalId!))
    expect(row.status).toBe('auto_rejected')
    expect(row.reviewerNote).toMatch(/verbatim/i)
  })
})

describe('stageExtraction — resolved entities', () => {
  const SOURCE_BODY = 'The article contains a verbatim quote right here.'

  it('stages an edge_create when no matching edge exists', async () => {
    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: SOURCE_BODY,
      extraction: extraction(),
      model: 'm',
      entityIndex: INDEX,
    })
    expect(result.status).toBe('pending')
    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.proposalId!))
    expect(row.kind).toBe('edge_create')
    expect(row.datasetId).toBe(LIVE)
    expect((row.payload as { source: { nodeId: string } }).source).toEqual({ nodeId: 'repsol' })
    expect((row.payload as { target: { nodeId: string } }).target).toEqual({
      nodeId: 'sonatrach',
    })
  })

  it('stages an edge_update, referencing the existing edge, when one already exists', async () => {
    await db.insert(edges).values({
      id: 'e1',
      datasetId: LIVE,
      sourceId: 'repsol',
      targetId: 'sonatrach',
      type: 'contractual',
      direction: 'mutual',
      strength: 50,
      state: 'stable',
      trajectory: 'stable',
      exposure: 'x',
      since: 2000,
      lastEventDate: '2025-01',
      lastEventSummary: 's',
      narrative: 'n',
      confidence: 'high',
    })

    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: SOURCE_BODY,
      extraction: extraction(),
      model: 'm',
      entityIndex: INDEX,
    })
    expect(result.status).toBe('pending')
    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.proposalId!))
    expect(row.kind).toBe('edge_update')
    expect(row.targetRef).toBe('e1')
  })

  it('matches an existing edge regardless of which side is source vs target', async () => {
    await db.insert(edges).values({
      id: 'e1',
      datasetId: LIVE,
      sourceId: 'sonatrach', // reversed relative to the extraction
      targetId: 'repsol',
      type: 'contractual',
      direction: 'mutual',
      strength: 50,
      state: 'stable',
      trajectory: 'stable',
      exposure: 'x',
      since: 2000,
      lastEventDate: '2025-01',
      lastEventSummary: 's',
      narrative: 'n',
      confidence: 'high',
    })
    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: SOURCE_BODY,
      extraction: extraction(),
      model: 'm',
      entityIndex: INDEX,
    })
    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.proposalId!))
    expect(row.kind).toBe('edge_update')
    expect(row.targetRef).toBe('e1')
  })

  it('proposes edge_create with a newName when one entity is unresolved', async () => {
    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: SOURCE_BODY,
      extraction: extraction({ targetEntity: 'TotalEnergies' }),
      model: 'm',
      entityIndex: INDEX,
    })
    expect(result.status).toBe('pending')
    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.proposalId!))
    expect((row.payload as { target: { newName: string } }).target).toEqual({
      newName: 'TotalEnergies',
    })
  })

  it('scores confidence numerically from the qualitative level', async () => {
    const { stageExtraction } = await stage()
    const result = await stageExtraction({
      datasetId: LIVE,
      sourceId: 'src1',
      sourceBody: SOURCE_BODY,
      extraction: extraction({ confidence: 'high' }),
      model: 'm',
      entityIndex: INDEX,
    })
    const [row] = await db.select().from(proposals).where(eq(proposals.id, result.proposalId!))
    expect(row.confidence).toBe(0.9)
  })
})

/**
 * The most important cross-cutting test in Phase 5: staging goes through the
 * SAME `proposals` table Phase 1 proved is structurally unproposable for the
 * illustrative demo. This confirms the ingestion write path — not just a
 * synthetic direct insert — is actually blocked by that constraint.
 */
describe('stageExtraction — demo dataset immutability', () => {
  it('cannot stage a proposal against the illustrative dataset', async () => {
    await addNode(DEMO, 'repsol', 'Repsol')
    await addNode(DEMO, 'sonatrach', 'Sonatrach')

    const { stageExtraction } = await stage()
    expect(
      await dbErrorMessage(() =>
        stageExtraction({
          datasetId: DEMO,
          sourceId: 'src1',
          sourceBody: 'a verbatim quote appears here',
          extraction: extraction(),
          model: 'm',
          entityIndex: INDEX,
        }),
      ),
    ).toMatch(/foreign key|proposals_dataset_fk/i)
  })
})
