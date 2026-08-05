import raw from '@/data/stakeholders.json'
import type { GraphData, RelationshipEdge, StakeholderNode, RelState } from './types'

export const graph = raw as unknown as GraphData & { disclaimer: string }

export const CLIENT_ID = graph.client

export const nodeById = new Map<string, StakeholderNode>(graph.nodes.map((n) => [n.id, n]))

/** Stable key for an edge. Two actors can hold more than one relationship. */
export function edgeKey(e: Pick<RelationshipEdge, 'source' | 'target' | 'type'>): string {
  const s = typeof e.source === 'string' ? e.source : (e.source as StakeholderNode).id
  const t = typeof e.target === 'string' ? e.target : (e.target as StakeholderNode).id
  return `${s}->${t}:${e.type}`
}

/** id -> set of directly connected ids. Used for one-hop focus mode. */
export const adjacency: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>()
  for (const n of graph.nodes) m.set(n.id, new Set())
  for (const e of graph.edges) {
    m.get(e.source)!.add(e.target)
    m.get(e.target)!.add(e.source)
  }
  return m
})()

export const degree = new Map<string, number>(
  graph.nodes.map((n) => [n.id, adjacency.get(n.id)!.size]),
)

/** Node radius in px. Influence drives area, not diameter, so big nodes don't dominate. */
export function radiusFor(influence: number, isClient: boolean): number {
  if (isClient) return 30
  return 7 + Math.sqrt(influence) * 1.5
}

/** Link stroke width in px from relationship strength. */
export function widthFor(strength: number): number {
  return 0.9 + (strength / 100) * 3.1
}

/** All edges touching a node, with the counterpart resolved. */
export function edgesFor(
  id: string,
): Array<{ edge: RelationshipEdge; other: StakeholderNode }> {
  return graph.edges
    .filter((e) => e.source === id || e.target === id)
    .map((e) => ({
      edge: e,
      other: nodeById.get(e.source === id ? e.target : e.source)!,
    }))
    .sort((a, b) => b.edge.strength - a.edge.strength)
}

/**
 * All direct client relationships for a stakeholder. Returns a list, not one
 * edge: a pair can hold more than one relationship at once (Repsol and
 * TotalEnergies are consortium partners *and* competitors), and showing only
 * the first would hide exactly the nuance the model exists to capture.
 */
export function clientEdgesFor(id: string): RelationshipEdge[] {
  return graph.edges
    .filter(
      (e) =>
        (e.source === CLIENT_ID && e.target === id) ||
        (e.target === CLIENT_ID && e.source === id),
    )
    .sort((a, b) => b.strength - a.strength)
}

/** Which way leverage runs, phrased for a reader. */
export function leverageLabel(e: RelationshipEdge): string {
  const s = nodeById.get(e.source)!.name
  const t = nodeById.get(e.target)!.name
  if (e.direction === 'mutual') return 'Mutual dependency'
  if (e.direction === 'source-depends') return `${s} depends on ${t}`
  return `${t} depends on ${s}`
}

export interface PortfolioSummary {
  total: number
  byState: Record<RelState, number>
  deteriorating: number
  improving: number
  /** Deteriorating relationships weighted by strength — the headline risk figure. */
  atRisk: Array<{ edge: RelationshipEdge; other: StakeholderNode }>
}

/** Aggregate read of the client's direct relationships, for the header strip. */
export function summarise(): PortfolioSummary {
  const direct = graph.edges.filter((e) => e.source === CLIENT_ID || e.target === CLIENT_ID)
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
      other: nodeById.get(e.source === CLIENT_ID ? e.target : e.source)!,
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
