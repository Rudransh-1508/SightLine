import { eq, and, or, desc } from 'drizzle-orm'

import { db } from '@/db/client'
import { datasets, nodes, edges, revisions } from '@/db/schema'
import type { GraphData, StakeholderNode, RelationshipEdge, DatasetKind } from './types'

/**
 * Dataset-scoped reads.
 *
 * These replace the module-level constants in graph.ts as the *source* of graph
 * data. The pure helpers in graph.ts (edgeKey, radiusFor, widthFor,
 * leverageLabel, summarise, buildAdjacency) are unchanged and still operate on
 * whatever GraphData they are handed — file-loaded or database-loaded.
 */

export interface DatasetSummary {
  id: string
  slug: string
  name: string
  kind: DatasetKind
  description: string | null
}

export async function listDatasets(): Promise<DatasetSummary[]> {
  const rows = await db.select().from(datasets).orderBy(datasets.slug)
  return rows.map((d) => ({
    id: d.id,
    slug: d.slug,
    name: d.name,
    kind: d.kind,
    description: d.description,
  }))
}

export async function getDataset(slug: string): Promise<DatasetSummary | null> {
  const [row] = await db.select().from(datasets).where(eq(datasets.slug, slug)).limit(1)
  if (!row) return null
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    description: row.description,
  }
}

function toNode(r: typeof nodes.$inferSelect): StakeholderNode {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    country: r.country,
    region: r.region,
    influence: r.influence,
    role: r.role,
    description: r.description,
    keyPeople: r.keyPeople ?? [],
  }
}

function toEdge(r: typeof edges.$inferSelect): RelationshipEdge {
  return {
    source: r.sourceId,
    target: r.targetId,
    type: r.type,
    direction: r.direction,
    strength: r.strength,
    state: r.state,
    trajectory: r.trajectory,
    exposure: r.exposure,
    since: r.since,
    lastEvent: { date: r.lastEventDate, summary: r.lastEventSummary },
    narrative: r.narrative,
    confidence: r.confidence,
  }
}

/**
 * Loads a whole dataset in the shape the existing renderer already consumes.
 *
 * Deliberately returns the same GraphData structure the JSON file produced, so
 * GraphCanvas, DetailPanel and Controls need no changes at all — the data
 * source moved, the contract did not.
 */
export async function getGraph(slug: string): Promise<(GraphData & DatasetSummary) | null> {
  const dataset = await getDataset(slug)
  if (!dataset) return null

  const [nodeRows, edgeRows] = await Promise.all([
    db.select().from(nodes).where(eq(nodes.datasetId, dataset.id)),
    db.select().from(edges).where(eq(edges.datasetId, dataset.id)),
  ])

  const client = nodeRows.find((n) => n.category === 'client')?.id ?? nodeRows[0]?.id ?? ''

  return {
    ...dataset,
    client,
    asOf: new Date().toISOString().slice(0, 10),
    nodes: nodeRows.map(toNode),
    edges: edgeRows.map(toEdge),
  }
}

export async function getNode(slug: string, nodeId: string): Promise<StakeholderNode | null> {
  const dataset = await getDataset(slug)
  if (!dataset) return null
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.datasetId, dataset.id), eq(nodes.id, nodeId)))
    .limit(1)
  return row ? toNode(row) : null
}

export interface RevisionEntry {
  field: string
  oldValue: string | null
  newValue: string | null
  appliedAt: string
  proposalId: string | null
}

/**
 * Change history for one relationship, newest first.
 *
 * Takes the edge's *logical* key (source, target, type) rather than its
 * database id, because that is the identity the graph, the UI focus mode and
 * the copilot's citations all use — `RelationshipEdge` deliberately carries no
 * surrogate id. The row id is resolved here and never leaves this module.
 */
export async function edgeRevisions(
  slug: string,
  source: string,
  target: string,
  type: RelationshipEdge['type'],
  limit = 20,
): Promise<RevisionEntry[]> {
  const dataset = await getDataset(slug)
  if (!dataset) return []

  const [edgeRow] = await db
    .select({ id: edges.id })
    .from(edges)
    .where(
      and(
        eq(edges.datasetId, dataset.id),
        eq(edges.sourceId, source),
        eq(edges.targetId, target),
        eq(edges.type, type),
      ),
    )
    .limit(1)
  if (!edgeRow) return []

  const rows = await db
    .select()
    .from(revisions)
    .where(and(eq(revisions.entityType, 'edge'), eq(revisions.entityId, edgeRow.id)))
    .orderBy(desc(revisions.appliedAt))
    .limit(limit)

  return rows.map((r) => ({
    field: r.field,
    oldValue: r.oldValue,
    newValue: r.newValue,
    appliedAt: r.appliedAt.toISOString(),
    proposalId: r.proposalId,
  }))
}

/** Every edge touching a node, from either direction. */
export async function edgesFor(slug: string, nodeId: string): Promise<RelationshipEdge[]> {
  const dataset = await getDataset(slug)
  if (!dataset) return []
  const rows = await db
    .select()
    .from(edges)
    .where(
      and(
        eq(edges.datasetId, dataset.id),
        or(eq(edges.sourceId, nodeId), eq(edges.targetId, nodeId)),
      ),
    )
  return rows.map(toEdge).sort((a, b) => b.strength - a.strength)
}
