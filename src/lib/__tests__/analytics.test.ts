import { describe, it, expect } from 'vitest'

import { computeMetrics, findPaths, topChokepoints } from '../analytics'
import { graph } from '../graph'
import type { GraphData, RelationshipEdge, StakeholderNode } from '../types'

function node(id: string): StakeholderNode {
  return {
    id,
    name: id.toUpperCase(),
    category: 'supplier',
    country: 'ES',
    region: 'Iberia',
    influence: 50,
    role: 'r',
    description: 'd',
  }
}

function edge(source: string, target: string, strength = 50): RelationshipEdge {
  return {
    source,
    target,
    type: 'equity',
    direction: 'mutual',
    strength,
    state: 'stable',
    trajectory: 'stable',
    exposure: 'x',
    since: 2000,
    lastEvent: { date: '2026-01', summary: 's' },
    narrative: 'n',
    confidence: 'high',
  }
}

function makeGraph(ids: string[], edges: RelationshipEdge[]): GraphData {
  return { client: ids[0], asOf: '2026-08-06', nodes: ids.map(node), edges }
}

/**
 * Betweenness on small graphs has known closed-form values, so these assert
 * exact numbers rather than merely "it returned something".
 */
describe('betweenness on known graphs', () => {
  it('gives the middle of a 3-path all the betweenness', () => {
    // a — b — c : every shortest path between a and c goes through b.
    const g = makeGraph(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    const m = computeMetrics(g)
    expect(m.get('b')!.betweenness).toBe(1)
    expect(m.get('a')!.betweenness).toBe(0)
    expect(m.get('c')!.betweenness).toBe(0)
  })

  it('gives every node zero betweenness in a triangle', () => {
    // Every pair is directly connected, so no node is ever an intermediary.
    const g = makeGraph(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c'), edge('a', 'c')])
    const m = computeMetrics(g)
    for (const id of ['a', 'b', 'c']) {
      expect(m.get(id)!.betweenness).toBe(0)
    }
  })

  it('gives the hub of a star all the betweenness', () => {
    const g = makeGraph(
      ['hub', 'a', 'b', 'c'],
      [edge('hub', 'a'), edge('hub', 'b'), edge('hub', 'c')],
    )
    const m = computeMetrics(g)
    expect(m.get('hub')!.betweenness).toBe(1)
    expect(m.get('a')!.betweenness).toBe(0)
  })

  /**
   * Guards the inversion trap documented in analytics.ts: betweenness weights
   * are distances, so feeding `strength` in directly would rank the WEAKEST
   * connections as the biggest chokepoints. Structure alone must decide.
   */
  it('is unaffected by edge strength', () => {
    const weak = makeGraph(['a', 'b', 'c'], [edge('a', 'b', 1), edge('b', 'c', 1)])
    const strong = makeGraph(['a', 'b', 'c'], [edge('a', 'b', 100), edge('b', 'c', 100)])
    expect(computeMetrics(weak).get('b')!.betweenness).toBe(
      computeMetrics(strong).get('b')!.betweenness,
    )
  })
})

describe('degree', () => {
  it('counts connections', () => {
    const g = makeGraph(
      ['hub', 'a', 'b', 'c'],
      [edge('hub', 'a'), edge('hub', 'b'), edge('hub', 'c')],
    )
    const m = computeMetrics(g)
    expect(m.get('hub')!.degree).toBe(3)
    expect(m.get('a')!.degree).toBe(1)
  })

  /**
   * A pair holding two relationships is structurally one connection. Counting
   * it twice would inflate the degree of exactly the most nuanced pairs.
   */
  it('counts a doubly-connected pair once', () => {
    const g = makeGraph(
      ['a', 'b'],
      [edge('a', 'b'), { ...edge('a', 'b'), type: 'adversarial' }],
    )
    const m = computeMetrics(g)
    expect(m.get('a')!.degree).toBe(1)
    expect(m.get('b')!.degree).toBe(1)
  })
})

describe('communities', () => {
  it('separates two clusters joined by a single bridge', () => {
    const g = makeGraph(
      ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'],
      [
        edge('a1', 'a2', 90),
        edge('a2', 'a3', 90),
        edge('a1', 'a3', 90),
        edge('b1', 'b2', 90),
        edge('b2', 'b3', 90),
        edge('b1', 'b3', 90),
        edge('a1', 'b1', 5), // weak bridge
      ],
    )
    const m = computeMetrics(g)
    expect(m.get('a1')!.community).toBe(m.get('a2')!.community)
    expect(m.get('b1')!.community).toBe(m.get('b2')!.community)
    expect(m.get('a1')!.community).not.toBe(m.get('b1')!.community)
  })
})

describe('edge cases', () => {
  it('returns nothing for an empty graph', () => {
    expect(computeMetrics(makeGraph([], []))).toEqual(new Map())
  })

  it('handles a node with no edges', () => {
    const g = makeGraph(['lonely'], [])
    const m = computeMetrics(g)
    expect(m.get('lonely')!.degree).toBe(0)
    expect(m.get('lonely')!.betweenness).toBe(0)
  })

  it('ignores an edge referencing an unknown node', () => {
    const g = makeGraph(['a', 'b'], [edge('a', 'b'), edge('a', 'ghost')])
    const m = computeMetrics(g)
    expect(m.size).toBe(2)
    expect(m.get('a')!.degree).toBe(1)
  })
})

describe('against the real dataset', () => {
  const metrics = computeMetrics(graph)

  it('produces metrics for every node', () => {
    expect(metrics.size).toBe(graph.nodes.length)
  })

  it('keeps normalised betweenness within 0-1', () => {
    for (const m of metrics.values()) {
      expect(m.betweenness).toBeGreaterThanOrEqual(0)
      expect(m.betweenness).toBeLessThanOrEqual(1)
    }
  })

  it('ranks the client among the top chokepoints', () => {
    // Repsol sits on most paths by construction — a sanity check that the
    // measure is oriented correctly rather than inverted.
    const top = topChokepoints(graph, 3).map((t) => t.id)
    expect(top).toContain(graph.client)
  })

  it('finds more than one community', () => {
    const communities = new Set([...metrics.values()].map((m) => m.community))
    expect(communities.size).toBeGreaterThan(1)
  })

  it('agrees with the hand-authored degree for a known node', () => {
    // Sonatrach: Repsol, Algeria, Naturgy.
    expect(metrics.get('sonatrach')!.degree).toBe(3)
  })
})

/**
 * Path enumeration answers "how does X reach Y", which the copilot must never
 * reason out for itself. Small graphs again, so the expected paths are
 * enumerable by hand rather than snapshotted.
 */
describe('findPaths', () => {
  it('finds the only route through a chain', () => {
    const g = makeGraph(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    expect(findPaths(g, 'a', 'c')).toEqual([['a', 'b', 'c']])
  })

  it('finds every alternative route, shortest first', () => {
    // a—b—d and a—c—d are both two hops; a—b—c—d is three.
    const g = makeGraph(
      ['a', 'b', 'c', 'd'],
      [edge('a', 'b'), edge('a', 'c'), edge('b', 'd'), edge('c', 'd'), edge('b', 'c')],
    )
    const paths = findPaths(g, 'a', 'd')

    expect(paths.slice(0, 2).map((p) => p.length)).toEqual([3, 3])
    expect(paths.map((p) => p.join('-'))).toEqual(
      expect.arrayContaining(['a-b-d', 'a-c-d', 'a-b-c-d', 'a-c-b-d']),
    )
  })

  it('respects the hop budget', () => {
    const g = makeGraph(['a', 'b', 'c'], [edge('a', 'b'), edge('b', 'c')])
    expect(findPaths(g, 'a', 'c', 1)).toEqual([])
  })

  it('returns nothing between disconnected actors', () => {
    const g = makeGraph(['a', 'b', 'c'], [edge('a', 'b')])
    expect(findPaths(g, 'a', 'c')).toEqual([])
  })

  it('never revisits a node, so it cannot loop on a cycle', () => {
    const g = makeGraph(
      ['a', 'b', 'c', 'd'],
      [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'd')],
    )
    for (const path of findPaths(g, 'a', 'd')) {
      expect(new Set(path).size).toBe(path.length)
    }
  })

  it('treats the graph as undirected, matching the centralities', () => {
    // The edge runs b -> a, but reachability is not about leverage direction.
    const g = makeGraph(['a', 'b'], [edge('b', 'a')])
    expect(findPaths(g, 'a', 'b')).toEqual([['a', 'b']])
  })
})
