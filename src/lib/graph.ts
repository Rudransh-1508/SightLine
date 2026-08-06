import raw from '@/data/stakeholders.json'
import type { GraphData, RelationshipEdge, StakeholderNode, RelState } from './types'

/*
 * Derived structures are built by `buildGraphIndex` from whatever GraphData it
 * is handed, so the same logic serves the file-backed demo fixture (used by the
 * tests below and by the seed) and the database-backed datasets the app now
 * renders. Previously these were module-level constants computed from the JSON
 * import, which meant every component was hard-wired to that one dataset.
 */

// --- pure, data-independent helpers ---------------------------------------

/** Stable key for an edge. Two actors can hold more than one relationship. */
export function edgeKey(e: Pick<RelationshipEdge, 'source' | 'target' | 'type'>): string {
  const s = typeof e.source === 'string' ? e.source : (e.source as StakeholderNode).id
  const t = typeof e.target === 'string' ? e.target : (e.target as StakeholderNode).id
  return `${s}->${t}:${e.type}`
}

/** Node radius in px. Influence drives area, not diameter, so big nodes don't dominate. */
export function radiusFor(influence: number, isClient: boolean): number {
  if (isClient) return 30
  return 7 + Math.sqrt(influence) * 1.5
}

/** Link stroke width in px from relationship strength. */
export function widthFor(strength: number): number {
  return 0.9 + (strength / 100) * 3.1
}

export interface PortfolioSummary {
  total: number
  byState: Record<RelState, number>
  deteriorating: number
  improving: number
  /** Deteriorating relationships weighted by strength — the headline risk figure. */
  atRisk: Array<{ edge: RelationshipEdge; other: StakeholderNode }>
}

export interface GraphIndex {
  data: GraphData
  clientId: string
  nodeById: Map<string, StakeholderNode>
  /** id -> set of directly connected ids. Used for one-hop focus mode. */
  adjacency: Map<string, Set<string>>
  degree: Map<string, number>
  /** All edges touching a node, with the counterpart resolved. */
  edgesFor(id: string): Array<{ edge: RelationshipEdge; other: StakeholderNode }>
  /**
   * All direct client relationships for a stakeholder. Returns a list, not one
   * edge: a pair can hold more than one relationship at once (Repsol and
   * TotalEnergies are consortium partners *and* competitors), and showing only
   * the first would hide exactly the nuance the model exists to capture.
   */
  clientEdgesFor(id: string): RelationshipEdge[]
  /** Which way leverage runs, phrased for a reader. */
  leverageLabel(e: RelationshipEdge): string
  /** Aggregate read of the client's direct relationships, for the header strip. */
  summarise(): PortfolioSummary
}

export function buildGraphIndex(data: GraphData): GraphIndex {
  const clientId = data.client
  const nodeById = new Map<string, StakeholderNode>(data.nodes.map((n) => [n.id, n]))

  const adjacency = new Map<string, Set<string>>()
  for (const n of data.nodes) adjacency.set(n.id, new Set())
  for (const e of data.edges) {
    adjacency.get(e.source)?.add(e.target)
    adjacency.get(e.target)?.add(e.source)
  }

  const degree = new Map<string, number>(
    data.nodes.map((n) => [n.id, adjacency.get(n.id)?.size ?? 0]),
  )

  function edgesFor(id: string) {
    return data.edges
      .filter((e) => e.source === id || e.target === id)
      .map((e) => ({
        edge: e,
        other: nodeById.get(e.source === id ? e.target : e.source)!,
      }))
      .sort((a, b) => b.edge.strength - a.edge.strength)
  }

  function clientEdgesFor(id: string) {
    return data.edges
      .filter(
        (e) =>
          (e.source === clientId && e.target === id) ||
          (e.target === clientId && e.source === id),
      )
      .sort((a, b) => b.strength - a.strength)
  }

  function leverageLabel(e: RelationshipEdge): string {
    const s = nodeById.get(e.source)?.name ?? e.source
    const t = nodeById.get(e.target)?.name ?? e.target
    if (e.direction === 'mutual') return 'Mutual dependency'
    if (e.direction === 'source-depends') return `${s} depends on ${t}`
    return `${t} depends on ${s}`
  }

  function summarise(): PortfolioSummary {
    const direct = data.edges.filter((e) => e.source === clientId || e.target === clientId)
    const byState = {
      hostile: 0,
      strained: 0,
      transactional: 0,
      stable: 0,
      cooperative: 0,
    } as Record<RelState, number>
    for (const e of direct) byState[e.state]++

    const atRisk = direct
      .filter((e) => e.trajectory === 'deteriorating')
      .map((e) => ({
        edge: e,
        other: nodeById.get(e.source === clientId ? e.target : e.source)!,
      }))
      .sort((a, b) => b.edge.strength - a.edge.strength)

    return {
      total: direct.length,
      byState,
      deteriorating: direct.filter((e) => e.trajectory === 'deteriorating').length,
      improving: direct.filter((e) => e.trajectory === 'improving').length,
      atRisk,
    }
  }

  return {
    data,
    clientId,
    nodeById,
    adjacency,
    degree,
    edgesFor,
    clientEdgesFor,
    leverageLabel,
    summarise,
  }
}

// --- the file-backed demo fixture -----------------------------------------

/*
 * stakeholders.json remains the source of truth for the illustrative dataset:
 * the seed loads it into `repsol-demo`, and the data-integrity tests guard it.
 * The application reads from the database instead — see src/lib/graph-db.ts.
 */

export const graph = raw as unknown as GraphData & { disclaimer: string }

export const demoIndex = buildGraphIndex(graph)

export const CLIENT_ID = demoIndex.clientId
export const nodeById = demoIndex.nodeById
export const adjacency = demoIndex.adjacency
export const degree = demoIndex.degree
export const edgesFor = demoIndex.edgesFor
export const clientEdgesFor = demoIndex.clientEdgesFor
export const leverageLabel = demoIndex.leverageLabel
export const summarise = demoIndex.summarise
