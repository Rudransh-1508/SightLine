import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'

import { createTestDb, type TestDb } from '@/db/__tests__/helpers'
import { datasets, nodes, edges, proposals, revisions, sources } from '@/db/schema'
import type { ProposalPayload } from '../review'

let db: TestDb
let currentDb: TestDb

vi.mock('@/db/client', () => ({
  get db() {
    return currentDb
  },
}))

const LIVE = 'live'

function payload(over: Partial<ProposalPayload> = {}): ProposalPayload {
  return {
    source: { nodeId: 'repsol' },
    target: { nodeId: 'sonatrach' },
    type: 'contractual',
    direction: 'source-depends',
    strength: 70,
    state: 'strained',
    trajectory: 'improving',
    exposure: 'gas supply',
    narrative: 'Price terms narrowed.',
    confidence: 'medium',
    ...over,
  }
}

async function addProposal(
  id: string,
  over: {
    kind?: 'edge_create' | 'edge_update'
    targetRef?: string | null
    payload?: ProposalPayload
    status?: 'pending' | 'approved' | 'rejected'
  } = {},
) {
  await db.insert(proposals).values({
    id,
    datasetId: LIVE,
    kind: over.kind ?? 'edge_create',
    targetRef: over.targetRef ?? null,
    payload: over.payload ?? payload(),
    evidenceQuote: 'a verbatim quote',
    sourceId: 'src1',
    confidence: 0.6,
    model: 'test-model',
    status: over.status ?? 'pending',
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
  currentDb = db
  await db.insert(datasets).values({ id: LIVE, slug: LIVE, name: 'Live', kind: 'sourced' })
  await db.insert(sources).values({
    id: 'src1',
    url: 'https://example.com/a',
    title: 'A story',
    publisher: 'The Guardian',
    contentHash: 'h1',
  })
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
})

async function review() {
  return import('../review')
}

describe('listPendingProposals', () => {
  it('returns only pending proposals, with their source joined', async () => {
    const { listPendingProposals } = await review()
    await addProposal('p1')
    await addProposal('p2', { status: 'approved' })

    const list = await listPendingProposals(LIVE)
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('p1')
    expect(list[0].source?.publisher).toBe('The Guardian')
    expect(list[0].evidenceQuote).toBe('a verbatim quote')
  })

  it('returns nothing for a dataset with no proposals', async () => {
    const { listPendingProposals } = await review()
    expect(await listPendingProposals(LIVE)).toEqual([])
  })
})

describe('approveProposal — edge_create', () => {
  it('creates the edge and marks the proposal approved', async () => {
    const { approveProposal } = await review()
    await addProposal('p1')

    const { edgeId } = await approveProposal('p1')

    const [edge] = await db.select().from(edges).where(eq(edges.id, edgeId))
    expect(edge.sourceId).toBe('repsol')
    expect(edge.targetId).toBe('sonatrach')
    expect(edge.state).toBe('strained')
    expect(edge.trajectory).toBe('improving')

    const [p] = await db.select().from(proposals).where(eq(proposals.id, 'p1'))
    expect(p.status).toBe('approved')
    expect(p.reviewedAt).not.toBeNull()
  })

  it('writes a revision recording the creation', async () => {
    const { approveProposal } = await review()
    await addProposal('p1')
    const { edgeId } = await approveProposal('p1')

    const rows = await db.select().from(revisions).where(eq(revisions.entityId, edgeId))
    expect(rows).toHaveLength(1)
    expect(rows[0].field).toBe('created')
    expect(rows[0].proposalId).toBe('p1')
  })

  it('creates a node for an unresolved entity and links the edge to it', async () => {
    const { approveProposal } = await review()
    await addProposal('p1', {
      payload: payload({ target: { newName: 'TotalEnergies' } }),
    })

    const { edgeId, createdNodeIds } = await approveProposal('p1')

    expect(createdNodeIds).toEqual(['totalenergies'])
    const [node] = await db.select().from(nodes).where(eq(nodes.id, 'totalenergies'))
    expect(node.name).toBe('TotalEnergies')

    const [edge] = await db.select().from(edges).where(eq(edges.id, edgeId))
    expect(edge.targetId).toBe('totalenergies')
  })

  it('reuses an existing node rather than duplicating it', async () => {
    const { approveProposal } = await review()
    // "Repsol" slugs to the id of the node already seeded above.
    await addProposal('p1', { payload: payload({ source: { newName: 'Repsol' } }) })

    const { createdNodeIds } = await approveProposal('p1')

    expect(createdNodeIds).toEqual([])
    expect(await db.select().from(nodes)).toHaveLength(2)
  })
})

describe('approveProposal — edge_update', () => {
  async function seedEdge() {
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
      exposure: 'old exposure',
      since: 2000,
      lastEventDate: '2025-01',
      lastEventSummary: 's',
      narrative: 'old narrative',
      confidence: 'high',
    })
  }

  it('updates only the fields the proposal specifies', async () => {
    const { approveProposal } = await review()
    await seedEdge()
    await addProposal('p1', {
      kind: 'edge_update',
      targetRef: 'e1',
      payload: payload({ state: 'hostile', trajectory: null, strength: null }),
    })

    await approveProposal('p1')

    const [edge] = await db.select().from(edges).where(eq(edges.id, 'e1'))
    expect(edge.state).toBe('hostile')
    // Left null in the payload, so it must be untouched.
    expect(edge.trajectory).toBe('stable')
    expect(edge.strength).toBe(50)
  })

  it('writes one revision per changed field, with old and new values', async () => {
    const { approveProposal } = await review()
    await seedEdge()
    await addProposal('p1', {
      kind: 'edge_update',
      targetRef: 'e1',
      payload: payload({ state: 'hostile', trajectory: 'deteriorating', strength: null }),
    })

    await approveProposal('p1')

    const rows = await db.select().from(revisions).where(eq(revisions.entityId, 'e1'))
    const byField = Object.fromEntries(rows.map((r) => [r.field, r]))
    expect(byField.state.oldValue).toBe('stable')
    expect(byField.state.newValue).toBe('hostile')
    expect(byField.trajectory.newValue).toBe('deteriorating')
    // strength was null in the payload — no revision for an unchanged field.
    expect(byField.strength).toBeUndefined()
  })

  it('writes no revision when a proposed value matches the current one', async () => {
    const { approveProposal } = await review()
    await seedEdge()
    await addProposal('p1', {
      kind: 'edge_update',
      targetRef: 'e1',
      payload: payload({
        state: 'stable',
        trajectory: null,
        strength: null,
        exposure: null,
        narrative: null,
        direction: null,
        confidence: null,
      }),
    })

    await approveProposal('p1')

    expect(await db.select().from(revisions).where(eq(revisions.entityId, 'e1'))).toHaveLength(
      0,
    )
  })
})

describe('approveProposal — guards', () => {
  it('refuses a proposal that is already approved', async () => {
    const { approveProposal, ProposalNotPendingError } = await review()
    await addProposal('p1', { status: 'approved' })
    await expect(approveProposal('p1')).rejects.toBeInstanceOf(ProposalNotPendingError)
  })

  it('refuses a second approval of the same proposal', async () => {
    const { approveProposal } = await review()
    await addProposal('p1')
    await approveProposal('p1')

    await expect(approveProposal('p1')).rejects.toThrow(/already approved/)
    // The double-approve must not have created a second edge.
    expect(await db.select().from(edges)).toHaveLength(1)
  })

  it('refuses an unknown proposal id', async () => {
    const { approveProposal } = await review()
    await expect(approveProposal('nope')).rejects.toThrow(/not found/)
  })

  it('refuses an edge_update whose target edge has disappeared', async () => {
    const { approveProposal } = await review()
    await addProposal('p1', { kind: 'edge_update', targetRef: 'gone' })
    await expect(approveProposal('p1')).rejects.toThrow(/no longer exists/)
  })
})

/**
 * The reason the app runs on the neon-serverless driver rather than neon-http:
 * approving touches several tables, and a partial apply would corrupt the
 * graph. If the transaction ever silently degraded to non-atomic writes, this
 * is the test that would catch it.
 */
describe('approveProposal — atomicity', () => {
  it('rolls back every write when the apply fails partway', async () => {
    const { approveProposal } = await review()
    // A new source node is created first, then the edge insert fails because
    // the target node does not exist — so the node creation must roll back too.
    await addProposal('p1', {
      payload: payload({
        source: { newName: 'BrandNewEntity' },
        target: { nodeId: 'does-not-exist' },
      }),
    })

    await expect(approveProposal('p1')).rejects.toThrow()

    // Nothing may survive: no node, no edge, no revision, and the proposal
    // must still be pending so it can be retried.
    expect(await db.select().from(nodes)).toHaveLength(2) // only the two seeded
    expect(await db.select().from(edges)).toHaveLength(0)
    expect(await db.select().from(revisions)).toHaveLength(0)
    const [p] = await db.select().from(proposals).where(eq(proposals.id, 'p1'))
    expect(p.status).toBe('pending')
  })
})

describe('rejectProposal', () => {
  it('marks the proposal rejected without touching the graph', async () => {
    const { rejectProposal } = await review()
    await addProposal('p1')

    await rejectProposal('p1', 'not a real relationship')

    const [p] = await db.select().from(proposals).where(eq(proposals.id, 'p1'))
    expect(p.status).toBe('rejected')
    expect(p.reviewerNote).toBe('not a real relationship')
    expect(await db.select().from(edges)).toHaveLength(0)
    expect(await db.select().from(revisions)).toHaveLength(0)
  })

  it('refuses to reject an already-reviewed proposal', async () => {
    const { rejectProposal, ProposalNotPendingError } = await review()
    await addProposal('p1', { status: 'rejected' })
    await expect(rejectProposal('p1')).rejects.toBeInstanceOf(ProposalNotPendingError)
  })
})
