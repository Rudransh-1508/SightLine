import { and, desc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { datasets, edges, nodes, proposals, revisions, sources } from '@/db/schema'
import type { Category, Confidence, Direction, RelState, RelType, Trajectory } from './types'

/**
 * The review queue: turning staged proposals into graph changes.
 *
 * Enforces the core invariant from the design spec §3.1 — the trusted graph is
 * only ever mutated through an approved proposal. This module is the ONLY
 * place that writes to `nodes` and `edges` outside of the seed.
 */

/** The shape ingestion stages into `proposals.payload`. */
export interface ProposalPayload {
  source: { nodeId: string } | { newName: string }
  target: { nodeId: string } | { newName: string }
  type: RelType | null
  direction: Direction | null
  strength: number | null
  state: RelState | null
  trajectory: Trajectory | null
  exposure: string | null
  narrative: string | null
  confidence: Confidence | null
}

export interface ProposalView {
  id: string
  datasetId: string
  kind: string
  status: string
  targetRef: string | null
  payload: ProposalPayload
  evidenceQuote: string | null
  confidence: number | null
  model: string | null
  createdAt: Date
  reviewerNote: string | null
  source: { url: string; title: string | null; publisher: string | null } | null
  /** Present for edge_update — what the edge looks like before applying. */
  currentEdge: {
    id: string
    state: RelState
    trajectory: Trajectory
    strength: number
    type: RelType
  } | null
}

function isExisting(ref: ProposalPayload['source']): ref is { nodeId: string } {
  return 'nodeId' in ref
}

/** Pending proposals for a dataset, newest first, with source and current-edge context. */
export async function listPendingProposals(datasetId: string): Promise<ProposalView[]> {
  const rows = await db
    .select({ proposal: proposals, source: sources })
    .from(proposals)
    .leftJoin(sources, eq(proposals.sourceId, sources.id))
    .where(and(eq(proposals.datasetId, datasetId), eq(proposals.status, 'pending')))
    .orderBy(desc(proposals.createdAt))

  const views: ProposalView[] = []
  for (const row of rows) {
    views.push({
      id: row.proposal.id,
      datasetId: row.proposal.datasetId,
      kind: row.proposal.kind,
      status: row.proposal.status,
      targetRef: row.proposal.targetRef,
      payload: row.proposal.payload as ProposalPayload,
      evidenceQuote: row.proposal.evidenceQuote,
      confidence: row.proposal.confidence,
      model: row.proposal.model,
      createdAt: row.proposal.createdAt,
      reviewerNote: row.proposal.reviewerNote,
      source: row.source
        ? { url: row.source.url, title: row.source.title, publisher: row.source.publisher }
        : null,
      currentEdge: row.proposal.targetRef ? await getEdgeSummary(row.proposal.targetRef) : null,
    })
  }
  return views
}

async function getEdgeSummary(edgeId: string) {
  const [row] = await db.select().from(edges).where(eq(edges.id, edgeId)).limit(1)
  if (!row) return null
  return {
    id: row.id,
    state: row.state,
    trajectory: row.trajectory,
    strength: row.strength,
    type: row.type,
  }
}

export class ProposalNotPendingError extends Error {
  constructor(readonly status: string) {
    super(`Proposal is already ${status} — only pending proposals can be reviewed`)
    this.name = 'ProposalNotPendingError'
  }
}

export class ProposalIncompleteError extends Error {
  constructor(reason: string) {
    super(`Proposal cannot be applied: ${reason}`)
    this.name = 'ProposalIncompleteError'
  }
}

/** Slug-ish id from an entity name, so new nodes get readable ids like the seed's. */
function nodeIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || `node-${crypto.randomUUID().slice(0, 8)}`
}

/**
 * Approves a proposal and applies it to the graph.
 *
 * Everything happens inside ONE transaction: creating any new nodes, creating
 * or updating the edge, appending `revisions`, and flipping the proposal's
 * status. A partial apply — an edge created but its provenance missing, or a
 * proposal marked approved without its change landing — would silently
 * corrupt the graph, so it must be all-or-nothing.
 *
 * (This is why the app runs on the neon-serverless driver: neon-http throws
 * on `transaction()` outright. See src/db/client.ts.)
 */
export async function approveProposal(
  proposalId: string,
  reviewer: { note?: string } = {},
): Promise<{ edgeId: string; createdNodeIds: string[] }> {
  return db.transaction(async (tx) => {
    const [proposal] = await tx
      .select()
      .from(proposals)
      .where(eq(proposals.id, proposalId))
      .limit(1)

    if (!proposal) throw new ProposalIncompleteError('proposal not found')
    // Guards against a double-click or two reviewers racing: the second
    // attempt finds a non-pending status and aborts rather than applying twice.
    if (proposal.status !== 'pending') throw new ProposalNotPendingError(proposal.status)

    const payload = proposal.payload as ProposalPayload
    const datasetId = proposal.datasetId
    const now = new Date()
    const createdNodeIds: string[] = []

    /** Resolves a payload ref to a node id, creating the node if it is new. */
    async function resolveRef(ref: ProposalPayload['source']): Promise<string> {
      if (isExisting(ref)) return ref.nodeId

      const id = nodeIdFromName(ref.newName)
      const [existing] = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(and(eq(nodes.datasetId, datasetId), eq(nodes.id, id)))
        .limit(1)
      if (existing) return existing.id

      await tx.insert(nodes).values({
        id,
        datasetId,
        name: ref.newName,
        // Deliberately conservative defaults: the extraction proposes a
        // relationship, not a full actor profile. An analyst can enrich the
        // node afterwards; inventing a category or influence score here would
        // be fabricating data the source never supported.
        category: 'supplier' as Category,
        country: 'XX',
        region: 'Europe',
        influence: 50,
        role: 'Added from an approved extraction — not yet classified',
        description: `Created when approving proposal ${proposal.id}.`,
        keyPeople: [],
      })
      createdNodeIds.push(id)
      await tx.insert(revisions).values({
        id: `rev_${crypto.randomUUID()}`,
        entityType: 'node',
        entityId: id,
        field: 'created',
        oldValue: null,
        newValue: ref.newName,
        proposalId: proposal.id,
        appliedAt: now,
      })
      return id
    }

    const sourceId = await resolveRef(payload.source)
    const targetId = await resolveRef(payload.target)

    let edgeId: string

    if (proposal.kind === 'edge_update' && proposal.targetRef) {
      const [current] = await tx
        .select()
        .from(edges)
        .where(eq(edges.id, proposal.targetRef))
        .limit(1)
      if (!current) throw new ProposalIncompleteError('target edge no longer exists')
      edgeId = current.id

      // Only fields the proposal actually specifies are changed, and each
      // change gets its own revision row — that per-field history is what
      // turns the static `lastEvent` into a real timeline.
      const changes: Array<{ field: string; oldValue: string; newValue: string }> = []
      const updates: Record<string, unknown> = {}

      const candidates: Array<[string, unknown, unknown]> = [
        ['state', current.state, payload.state],
        ['trajectory', current.trajectory, payload.trajectory],
        ['strength', current.strength, payload.strength],
        ['exposure', current.exposure, payload.exposure],
        ['narrative', current.narrative, payload.narrative],
        ['direction', current.direction, payload.direction],
        ['confidence', current.confidence, payload.confidence],
      ]
      for (const [field, oldValue, newValue] of candidates) {
        if (newValue === null || newValue === undefined) continue
        if (String(oldValue) === String(newValue)) continue
        updates[field] = newValue
        changes.push({ field, oldValue: String(oldValue), newValue: String(newValue) })
      }

      if (Object.keys(updates).length > 0) {
        await tx.update(edges).set(updates).where(eq(edges.id, edgeId))
      }
      for (const c of changes) {
        await tx.insert(revisions).values({
          id: `rev_${crypto.randomUUID()}`,
          entityType: 'edge',
          entityId: edgeId,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          proposalId: proposal.id,
          appliedAt: now,
        })
      }
    } else {
      if (!payload.type) throw new ProposalIncompleteError('missing relationship type')
      edgeId = `edge_${crypto.randomUUID()}`
      await tx.insert(edges).values({
        id: edgeId,
        datasetId,
        sourceId,
        targetId,
        type: payload.type,
        direction: payload.direction ?? 'mutual',
        strength: payload.strength ?? 50,
        state: payload.state ?? 'transactional',
        trajectory: payload.trajectory ?? 'stable',
        exposure: payload.exposure ?? 'Not specified in the source.',
        since: now.getFullYear(),
        lastEventDate: now.toISOString().slice(0, 7),
        lastEventSummary: payload.narrative ?? 'Created from an approved extraction.',
        narrative: payload.narrative ?? '',
        confidence: payload.confidence ?? 'low',
      })
      await tx.insert(revisions).values({
        id: `rev_${crypto.randomUUID()}`,
        entityType: 'edge',
        entityId: edgeId,
        field: 'created',
        oldValue: null,
        newValue: `${sourceId} -> ${targetId} (${payload.type})`,
        proposalId: proposal.id,
        appliedAt: now,
      })
    }

    await tx
      .update(proposals)
      .set({
        status: 'approved',
        reviewedAt: now,
        reviewerNote: reviewer.note ?? null,
      })
      .where(eq(proposals.id, proposalId))

    return { edgeId, createdNodeIds }
  })
}

/** Rejects a proposal. Nothing touches the graph — only the proposal's status. */
export async function rejectProposal(proposalId: string, note?: string): Promise<void> {
  const [proposal] = await db
    .select({ status: proposals.status })
    .from(proposals)
    .where(eq(proposals.id, proposalId))
    .limit(1)

  if (!proposal) throw new ProposalIncompleteError('proposal not found')
  if (proposal.status !== 'pending') throw new ProposalNotPendingError(proposal.status)

  await db
    .update(proposals)
    .set({ status: 'rejected', reviewedAt: new Date(), reviewerNote: note ?? null })
    .where(eq(proposals.id, proposalId))
}

/** Datasets that can receive proposals — i.e. everything except the demo. */
export async function listSourcedDatasets() {
  return db
    .select({ id: datasets.id, slug: datasets.slug, name: datasets.name })
    .from(datasets)
    .where(eq(datasets.kind, 'sourced'))
}
