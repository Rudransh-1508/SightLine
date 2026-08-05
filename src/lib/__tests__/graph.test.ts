import { describe, it, expect } from 'vitest'
import {
  graph,
  CLIENT_ID,
  nodeById,
  adjacency,
  degree,
  edgeKey,
  edgesFor,
  clientEdgesFor,
  leverageLabel,
  radiusFor,
  widthFor,
  summarise,
} from '../graph'

describe('edgeKey', () => {
  it('distinguishes two relationships between the same pair', () => {
    const a = edgeKey({ source: 'repsol', target: 'totalenergies', type: 'equity' })
    const b = edgeKey({ source: 'repsol', target: 'totalenergies', type: 'adversarial' })
    expect(a).not.toBe(b)
  })

  it('is stable for the same edge', () => {
    const e = { source: 'a', target: 'b', type: 'equity' } as const
    expect(edgeKey(e)).toBe(edgeKey(e))
  })
})

describe('adjacency and degree', () => {
  it('is symmetric', () => {
    for (const [id, neighbours] of adjacency) {
      for (const n of neighbours) {
        expect(adjacency.get(n)!.has(id)).toBe(true)
      }
    }
  })

  it('never lists a node as its own neighbour', () => {
    for (const [id, neighbours] of adjacency) {
      expect(neighbours.has(id)).toBe(false)
    }
  })

  it('agrees with the degree map', () => {
    for (const [id, neighbours] of adjacency) {
      expect(degree.get(id)).toBe(neighbours.size)
    }
  })

  it('makes the client the most connected actor', () => {
    const max = Math.max(...[...degree.values()])
    expect(degree.get(CLIENT_ID)).toBe(max)
  })
})

describe('edgesFor', () => {
  it('returns every edge touching a node, from both directions', () => {
    const id = 'sonatrach'
    const expected = graph.edges.filter((e) => e.source === id || e.target === id).length
    expect(edgesFor(id)).toHaveLength(expected)
  })

  it('resolves the counterpart rather than echoing the node back', () => {
    for (const { other } of edgesFor('sonatrach')) {
      expect(other.id).not.toBe('sonatrach')
    }
  })

  it('sorts by descending strength', () => {
    const s = edgesFor(CLIENT_ID).map((x) => x.edge.strength)
    expect(s).toEqual([...s].sort((a, b) => b - a))
  })

  it('returns nothing for an unknown id', () => {
    expect(edgesFor('does-not-exist')).toEqual([])
  })
})

/** This is the regression test for the .find() bug that hid TotalEnergies' second edge. */
describe('clientEdgesFor', () => {
  it('returns BOTH relationships when a pair holds two', () => {
    const edges = clientEdgesFor('totalenergies')
    expect(edges).toHaveLength(2)
    expect(new Set(edges.map((e) => e.type))).toEqual(new Set(['equity', 'adversarial']))
  })

  it('returns one relationship for an ordinary counterpart', () => {
    expect(clientEdgesFor('sonatrach')).toHaveLength(1)
  })

  it('returns nothing for an actor with no direct client tie', () => {
    const indirect = graph.nodes.find(
      (n) =>
        n.id !== CLIENT_ID &&
        !graph.edges.some(
          (e) =>
            (e.source === CLIENT_ID && e.target === n.id) ||
            (e.target === CLIENT_ID && e.source === n.id),
        ),
    )
    if (indirect) expect(clientEdgesFor(indirect.id)).toEqual([])
  })

  it('finds the edge regardless of which end the client sits on', () => {
    for (const n of graph.nodes) {
      if (n.id === CLIENT_ID) continue
      const direct = graph.edges.filter(
        (e) =>
          (e.source === CLIENT_ID && e.target === n.id) ||
          (e.target === CLIENT_ID && e.source === n.id),
      )
      expect(clientEdgesFor(n.id)).toHaveLength(direct.length)
    }
  })
})

describe('leverageLabel', () => {
  const base = {
    type: 'contractual',
    strength: 50,
    state: 'stable',
    trajectory: 'stable',
  } as const

  it('names the dependent party for source-depends', () => {
    const label = leverageLabel({
      ...base,
      source: 'repsol',
      target: 'sonatrach',
      direction: 'source-depends',
    } as never)
    expect(label).toBe('Repsol depends on Sonatrach')
  })

  it('flips the sentence for target-depends', () => {
    const label = leverageLabel({
      ...base,
      source: 'repsol',
      target: 'sonatrach',
      direction: 'target-depends',
    } as never)
    expect(label).toBe('Sonatrach depends on Repsol')
  })

  it('reports mutual dependency without naming a direction', () => {
    const label = leverageLabel({
      ...base,
      source: 'repsol',
      target: 'sonatrach',
      direction: 'mutual',
    } as never)
    expect(label).toBe('Mutual dependency')
  })
})

describe('visual scales', () => {
  it('gives the client the largest radius', () => {
    const others = graph.nodes
      .filter((n) => n.id !== CLIENT_ID)
      .map((n) => radiusFor(n.influence, false))
    expect(radiusFor(100, true)).toBeGreaterThan(Math.max(...others))
  })

  it('grows radius monotonically with influence', () => {
    expect(radiusFor(80, false)).toBeGreaterThan(radiusFor(40, false))
  })

  it('keeps every link width visible and bounded', () => {
    for (const s of [0, 50, 100]) {
      expect(widthFor(s)).toBeGreaterThan(0.5)
      expect(widthFor(s)).toBeLessThanOrEqual(4)
    }
  })
})

describe('summarise', () => {
  const s = summarise()

  it("counts exactly the client's direct relationships", () => {
    const direct = graph.edges.filter(
      (e) => e.source === CLIENT_ID || e.target === CLIENT_ID,
    ).length
    expect(s.total).toBe(direct)
  })

  it('has a state breakdown summing to the total', () => {
    const sum = Object.values(s.byState).reduce((a, b) => a + b, 0)
    expect(sum).toBe(s.total)
  })

  it('lists every deteriorating relationship in atRisk', () => {
    expect(s.atRisk).toHaveLength(s.deteriorating)
  })

  it('orders atRisk by descending strength', () => {
    const v = s.atRisk.map((x) => x.edge.strength)
    expect(v).toEqual([...v].sort((a, b) => b - a))
  })

  it('resolves the counterpart of each at-risk edge', () => {
    for (const { other } of s.atRisk) {
      expect(other.id).not.toBe(CLIENT_ID)
      expect(nodeById.has(other.id)).toBe(true)
    }
  })
})
