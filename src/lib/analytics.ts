import Graph from 'graphology'
import betweennessCentrality from 'graphology-metrics/centrality/betweenness'
import eigenvectorCentrality from 'graphology-metrics/centrality/eigenvector'
import louvain from 'graphology-communities-louvain'

import type { GraphData } from './types'

/**
 * Structural analytics.
 *
 * These are deterministic graph algorithms, not model calls — they cost zero
 * credits and stay available to a user with no balance. That is a deliberate
 * product decision: the analytical value of the graph must not be paywalled.
 */

export interface NodeMetrics {
  betweenness: number
  degree: number
  eigenvector: number
  community: number
}

/**
 * Builds an undirected graph for structural analysis.
 *
 * Two deliberate choices:
 *
 * 1. UNDIRECTED. `direction` on an edge encodes *leverage* (who needs whom),
 *    not connectivity. Influence and information flow both ways regardless, so
 *    treating the graph as directed would distort every centrality measure.
 *
 * 2. PARALLEL EDGES MERGE. A pair may hold several relationships (Repsol and
 *    TotalEnergies are consortium partners *and* competitors). Structurally
 *    that is one connection, so their strengths are summed into a single
 *    weighted edge rather than counted as two paths.
 */
function toGraphology(data: GraphData): Graph {
  const g = new Graph({ type: 'undirected', multi: false })

  for (const n of data.nodes) g.addNode(n.id, { influence: n.influence })

  for (const e of data.edges) {
    if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue
    if (g.hasEdge(e.source, e.target)) {
      const existing = g.getEdgeAttribute(e.source, e.target, 'weight') as number
      g.setEdgeAttribute(e.source, e.target, 'weight', existing + e.strength)
    } else {
      g.addEdge(e.source, e.target, { weight: e.strength })
    }
  }

  return g
}

export function computeMetrics(data: GraphData): Map<string, NodeMetrics> {
  const g = toGraphology(data)
  const result = new Map<string, NodeMetrics>()

  if (g.order === 0) return result

  /*
   * Betweenness is computed UNWEIGHTED, deliberately.
   *
   * Betweenness weights are *distances* — a larger weight means a longer path.
   * Our `strength` means the opposite: a stronger relationship is a closer one.
   * Passing strength directly would invert the metric and quietly rank the
   * least-connected actors as the biggest chokepoints. Correcting it requires
   * inverting to a distance (1/strength), which makes the number hard to
   * explain. Pure structure — "how many shortest paths run through this
   * actor" — is both correct and defensible.
   */
  const betweenness = betweennessCentrality(g, { normalized: true })

  /*
   * Eigenvector and Louvain take weight as *importance*, which is exactly what
   * strength means, so both are weighted.
   */
  let eigenvector: Record<string, number>
  try {
    eigenvector = eigenvectorCentrality(g, { getEdgeWeight: 'weight' })
  } catch {
    // Power iteration can fail to converge on degenerate graphs (e.g. a single
    // disconnected node). Degrade to zeroes rather than failing the request.
    eigenvector = Object.fromEntries(g.nodes().map((n) => [n, 0]))
  }

  const communities = louvain(g, { getEdgeWeight: 'weight' })

  for (const id of g.nodes()) {
    result.set(id, {
      betweenness: betweenness[id] ?? 0,
      degree: g.degree(id),
      eigenvector: eigenvector[id] ?? 0,
      community: communities[id] ?? 0,
    })
  }

  return result
}

/**
 * Every simple path between two actors, shortest first, up to `maxHops` edges.
 *
 * Enumerates paths rather than returning one shortest path: "how does OFAC
 * reach Repsol?" is usually answered by *which* routes exist, and a single
 * shortest path hides an alternative of equal length through a different
 * actor. Depth-first with a visited set on the current path keeps it simple
 * and cycle-free; `maxHops` bounds the search, which matters because path
 * enumeration is exponential in the worst case.
 *
 * Undirected for the same reason as the centralities: `direction` encodes
 * leverage, not reachability.
 */
export function findPaths(
  data: GraphData,
  fromId: string,
  toId: string,
  maxHops = 3,
  limit = 10,
): string[][] {
  const adjacency = new Map<string, Set<string>>()
  for (const n of data.nodes) adjacency.set(n.id, new Set())
  for (const e of data.edges) {
    adjacency.get(e.source)?.add(e.target)
    adjacency.get(e.target)?.add(e.source)
  }

  if (!adjacency.has(fromId) || !adjacency.has(toId) || fromId === toId) return []

  const found: string[][] = []
  const path: string[] = [fromId]
  const onPath = new Set<string>([fromId])

  const walk = (current: string) => {
    if (found.length >= limit) return
    if (path.length - 1 >= maxHops) return
    for (const next of adjacency.get(current) ?? []) {
      if (onPath.has(next)) continue
      path.push(next)
      if (next === toId) {
        found.push([...path])
      } else {
        onPath.add(next)
        walk(next)
        onPath.delete(next)
      }
      path.pop()
      if (found.length >= limit) return
    }
  }

  walk(fromId)
  return found.sort((a, b) => a.length - b.length).slice(0, limit)
}

/** Actors with the highest betweenness — the chokepoints exposure routes through. */
export function topChokepoints(
  data: GraphData,
  limit = 5,
): Array<{ id: string; name: string; betweenness: number }> {
  const metrics = computeMetrics(data)
  const nameById = new Map(data.nodes.map((n) => [n.id, n.name]))
  return [...metrics.entries()]
    .map(([id, m]) => ({ id, name: nameById.get(id) ?? id, betweenness: m.betweenness }))
    .sort((a, b) => b.betweenness - a.betweenness)
    .slice(0, limit)
}
