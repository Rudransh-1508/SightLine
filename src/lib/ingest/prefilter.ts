import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { nodes, entityAliases } from '@/db/schema'

/**
 * Deterministic relevance filter. Zero model calls, zero credits, unlimited —
 * see design spec §3.4.1/§4: this is what removes the largest stage of the
 * pipeline from the free tier's 50-requests/day budget before anything reaches
 * a model. Only documents that match here are ever batched for triage.
 */

export interface EntityIndexEntry {
  nodeId: string
  /** Node name plus every alias, already normalised for matching. */
  matchers: string[]
}

/** One entry per node: its own name plus every row in entity_aliases. */
export async function loadEntityIndex(datasetId: string): Promise<EntityIndexEntry[]> {
  const nodeRows = await db
    .select({ id: nodes.id, name: nodes.name })
    .from(nodes)
    .where(eq(nodes.datasetId, datasetId))

  const aliasRows = await db
    .select({ nodeId: entityAliases.nodeId, alias: entityAliases.alias })
    .from(entityAliases)
    .where(eq(entityAliases.datasetId, datasetId))

  const aliasesByNode = new Map<string, string[]>()
  for (const a of aliasRows) {
    aliasesByNode.set(a.nodeId, [...(aliasesByNode.get(a.nodeId) ?? []), a.alias])
  }

  return nodeRows.map((n) => ({
    nodeId: n.id,
    matchers: [n.name, ...(aliasesByNode.get(n.id) ?? [])],
  }))
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * A compiled index is rebuilt once per ingestion run, not once per document —
 * pipeline.ts calls this once and reuses it across every fetched document.
 */
export interface CompiledEntityIndex {
  test(text: string): string[]
}

export function compileEntityIndex(index: EntityIndexEntry[]): CompiledEntityIndex {
  const patterns = index.flatMap((entry) =>
    entry.matchers
      .filter((m) => m.trim().length > 0)
      .map((m) => ({
        nodeId: entry.nodeId,
        // Word-boundary match, case-insensitive. Deliberately a substring
        // match rather than an exact-token match: "Repsol" inside "Repsol
        // Sinopec" still counts as a mention worth checking, and the cost of
        // an occasional over-inclusive prefilter hit is one extra document in
        // a batched triage call — cheap. Disambiguating WHICH entity is meant
        // is stage 4's job (entity resolution), not this one's.
        regex: new RegExp(`\\b${escapeRegExp(m)}\\b`, 'i'),
      })),
  )

  return {
    test(text: string): string[] {
      const hits = new Set<string>()
      for (const p of patterns) {
        if (p.regex.test(text)) hits.add(p.nodeId)
      }
      return [...hits]
    },
  }
}

/**
 * Filters documents down to those mentioning at least one tracked entity.
 * Everything dropped here never reaches an LLM.
 */
export function prefilterDocuments<T extends { title: string; body: string }>(
  docs: T[],
  compiled: CompiledEntityIndex,
): Array<T & { matchedNodeIds: string[] }> {
  return docs
    .map((doc) => ({ ...doc, matchedNodeIds: compiled.test(`${doc.title} ${doc.body}`) }))
    .filter((doc) => doc.matchedNodeIds.length > 0)
}
