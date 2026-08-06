import { and, eq, or } from 'drizzle-orm'

import { db } from '@/db/client'
import { edges, proposals } from '@/db/schema'
import type { ProposalKind, ProposalStatus } from '@/lib/types'
import { verifyEvidenceQuote } from './evidence'
import { resolveEntity, type ResolvedEntity } from './resolve'
import type { EntityIndexEntry } from './prefilter'
import type { ExtractionResponse } from './schemas'

/**
 * Confidence numbers proposals.confidence stores (0-1), distinct from the edge
 * schema's own qualitative high/medium/low — this one drives sorting and
 * filtering in the review queue, the qualitative one is part of the proposed
 * edge data itself and lives inside payload.
 */
const CONFIDENCE_SCORE: Record<string, number> = { high: 0.9, medium: 0.6, low: 0.3 }

export interface StageParams {
  datasetId: string
  sourceId: string
  sourceBody: string
  extraction: ExtractionResponse
  model: string
  entityIndex: EntityIndexEntry[]
}

export interface StageResult {
  proposalId: string | null
  status: ProposalStatus | null
  reason?: string
}

function refFor(entity: ResolvedEntity): { nodeId: string } | { newName: string } {
  return entity.kind === 'existing'
    ? { nodeId: entity.nodeId }
    : { newName: entity.proposedName }
}

async function findExistingEdge(
  datasetId: string,
  a: string,
  b: string,
  type: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: edges.id })
    .from(edges)
    .where(
      and(
        eq(edges.datasetId, datasetId),
        eq(edges.type, type as never),
        or(
          and(eq(edges.sourceId, a), eq(edges.targetId, b)),
          and(eq(edges.sourceId, b), eq(edges.targetId, a)),
        ),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Writes a proposal from a validated extraction. Never writes to `nodes` or
 * `edges` directly — the core invariant from design spec §3.1: the trusted
 * graph only ever changes through an approved proposal, applied elsewhere
 * (Phase 6's review queue).
 */
export async function stageExtraction(params: StageParams): Promise<StageResult> {
  const { datasetId, sourceId, sourceBody, extraction, model, entityIndex } = params

  if (!extraction.found) {
    return { proposalId: null, status: null, reason: 'no_relationship_found' }
  }

  const id = `prop_${crypto.randomUUID()}`
  const confidenceScore = extraction.confidence ? CONFIDENCE_SCORE[extraction.confidence] : null

  const evidenceOk = verifyEvidenceQuote(extraction.evidenceQuote, sourceBody)
  if (!evidenceOk) {
    // Written, not discarded: an auto-rejection is still an auditable event —
    // it just never reaches the review queue, which filters on status='pending'.
    await db.insert(proposals).values({
      id,
      datasetId,
      kind: 'edge_create',
      payload: extraction,
      evidenceQuote: extraction.evidenceQuote,
      sourceId,
      confidence: confidenceScore,
      model,
      status: 'auto_rejected',
      reviewedAt: new Date(),
      reviewerNote: 'Evidence quote does not appear verbatim in the source document.',
    })
    return { proposalId: id, status: 'auto_rejected', reason: 'evidence_not_verbatim' }
  }

  if (!extraction.sourceEntity || !extraction.targetEntity) {
    return { proposalId: null, status: null, reason: 'missing_entity_name' }
  }

  const source = resolveEntity(extraction.sourceEntity, entityIndex)
  const target = resolveEntity(extraction.targetEntity, entityIndex)

  let kind: ProposalKind = 'edge_create'
  let targetRef: string | null = null

  if (source.kind === 'existing' && target.kind === 'existing') {
    const existing = await findExistingEdge(
      datasetId,
      source.nodeId,
      target.nodeId,
      extraction.relationshipType ?? 'contractual',
    )
    if (existing) {
      kind = 'edge_update'
      targetRef = existing.id
    }
  }

  const payload = {
    source: refFor(source),
    target: refFor(target),
    type: extraction.relationshipType,
    direction: extraction.direction,
    strength: extraction.strength,
    state: extraction.state,
    trajectory: extraction.trajectory,
    exposure: extraction.exposure,
    narrative: extraction.narrative,
    confidence: extraction.confidence,
  }

  await db.insert(proposals).values({
    id,
    datasetId,
    kind,
    targetRef,
    payload,
    evidenceQuote: extraction.evidenceQuote,
    sourceId,
    confidence: confidenceScore,
    model,
    status: 'pending',
  })

  return { proposalId: id, status: 'pending' }
}
