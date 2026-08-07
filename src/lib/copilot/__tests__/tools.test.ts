import { describe, it, expect, vi } from 'vitest'

import { contextFromGraph, createToolRunner, TOOL_DEFINITIONS } from '../tools'
import type { GraphData, RelationshipEdge, StakeholderNode } from '@/lib/types'

/**
 * Tools are pure reads over an in-memory graph, so these tests need no
 * database and no network. The fixture is small and hand-built precisely so
 * expected results can be reasoned about rather than snapshotted.
 *
 *   repsol — sonatrach — algeria      (a 2-hop route)
 *   repsol — cnmc                     (regulatory, deteriorating)
 */
function node(id: string, over: Partial<StakeholderNode> = {}): StakeholderNode {
  return {
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    category: 'supplier',
    country: 'ES',
    region: 'Iberia',
    influence: 50,
    role: 'a role',
    description: 'a description',
    ...over,
  }
}

function edge(
  source: string,
  target: string,
  over: Partial<RelationshipEdge> = {},
): RelationshipEdge {
  return {
    source,
    target,
    type: 'contractual',
    direction: 'source-depends',
    strength: 60,
    state: 'stable',
    trajectory: 'stable',
    exposure: 'gas supply',
    since: 2010,
    lastEvent: { date: '2026-01', summary: 'an event' },
    narrative: 'a narrative',
    confidence: 'high',
    ...over,
  }
}

const GRAPH: GraphData = {
  client: 'repsol',
  asOf: '2026-08-06',
  nodes: [
    node('repsol', { name: 'Repsol', category: 'client', influence: 100 }),
    node('sonatrach', { name: 'Sonatrach', country: 'DZ', region: 'North Africa' }),
    node('algeria', {
      name: 'Algeria',
      category: 'government',
      country: 'DZ',
      region: 'North Africa',
    }),
    node('cnmc', {
      name: 'CNMC',
      category: 'regulator',
      influence: 70,
      role: 'competition regulator',
    }),
  ],
  edges: [
    edge('repsol', 'sonatrach', { strength: 85 }),
    edge('sonatrach', 'algeria', { type: 'equity', strength: 90 }),
    edge('repsol', 'cnmc', {
      type: 'regulatory',
      strength: 40,
      state: 'strained',
      trajectory: 'deteriorating',
    }),
  ],
}

function runner(timeline = vi.fn(async () => [])) {
  return createToolRunner(contextFromGraph(GRAPH, timeline))
}

async function call(r: ReturnType<typeof runner>, name: string, args: object) {
  const run = await r.execute(name, JSON.stringify(args))
  return run
}

describe('tool definitions', () => {
  it('describes every property it exposes', () => {
    for (const tool of TOOL_DEFINITIONS) {
      const props = (
        tool.parameters as { properties: Record<string, { description?: string }> }
      ).properties
      for (const [name, prop] of Object.entries(props)) {
        expect(prop.description, `${tool.name}.${name} has no description`).toBeTruthy()
      }
    }
  })

  it('matches the executable tool set exactly', async () => {
    const r = runner()
    for (const tool of TOOL_DEFINITIONS) {
      const run = await r.execute(tool.name, '{}')
      // A defined-but-unimplemented tool would come back as "Unknown tool".
      expect(JSON.stringify(run.result)).not.toContain('Unknown tool')
    }
  })
})

describe('search_entities', () => {
  it('matches on name and returns ids', async () => {
    const run = await call(runner(), 'search_entities', { query: 'sonatrach' })
    expect(run.result).toMatchObject({ matches: [{ node_id: 'sonatrach', name: 'Sonatrach' }] })
  })

  it('matches on role and region, not just name', async () => {
    const byRole = await call(runner(), 'search_entities', { query: 'competition regulator' })
    expect((byRole.result as { matches: { node_id: string }[] }).matches[0].node_id).toBe(
      'cnmc',
    )

    const byRegion = await call(runner(), 'search_entities', { query: 'north africa' })
    const ids = (byRegion.result as { matches: { node_id: string }[] }).matches.map(
      (m) => m.node_id,
    )
    expect(ids).toEqual(expect.arrayContaining(['sonatrach', 'algeria']))
  })

  it('returns an empty match list rather than an error for a miss', async () => {
    const run = await call(runner(), 'search_entities', { query: 'gazprom' })
    expect(run.isError).toBe(false)
    expect(run.result).toEqual({ matches: [] })
  })
})

describe('get_node', () => {
  it('returns detail, metrics and a relationship count', async () => {
    const run = await call(runner(), 'get_node', { node_id: 'sonatrach' })
    expect(run.result).toMatchObject({
      node_id: 'sonatrach',
      name: 'Sonatrach',
      relationship_count: 2,
    })
    expect((run.result as { metrics: unknown }).metrics).toBeTruthy()
  })

  /**
   * A wrong id is a recoverable mistake — the model can search and retry — so
   * it comes back as a tool result, not as a thrown error that would fail the
   * whole request and refund a question the user could have got an answer to.
   */
  it('reports an unknown id as a tool error, not a throw', async () => {
    const run = await call(runner(), 'get_node', { node_id: 'nope' })
    expect(run.isError).toBe(true)
    expect(JSON.stringify(run.result)).toMatch(/No node with id/)
  })
})

describe('get_relationships', () => {
  it('returns both directions, strongest first, with edge ids', async () => {
    const run = await call(runner(), 'get_relationships', { node_id: 'repsol' })
    const rels = (run.result as { relationships: { edge_id: string; strength: number }[] })
      .relationships
    expect(rels.map((r) => r.edge_id)).toEqual([
      'repsol->sonatrach:contractual',
      'repsol->cnmc:regulatory',
    ])
    expect(rels[0].strength).toBe(85)
  })

  it('applies state, trajectory and strength filters', async () => {
    const byState = await call(runner(), 'get_relationships', {
      node_id: 'repsol',
      state: 'strained',
    })
    expect(
      (byState.result as { relationships: { edge_id: string }[] }).relationships,
    ).toHaveLength(1)

    const byStrength = await call(runner(), 'get_relationships', {
      node_id: 'repsol',
      min_strength: 80,
    })
    expect(
      (byStrength.result as { relationships: { edge_id: string }[] }).relationships[0].edge_id,
    ).toBe('repsol->sonatrach:contractual')
  })
})

describe('find_paths', () => {
  it('finds the two-hop route and the edges on it', async () => {
    const run = await call(runner(), 'find_paths', { from_id: 'repsol', to_id: 'algeria' })
    const result = run.result as {
      path_count: number
      paths: { node_ids: string[]; hops: { via: { edge_id: string }[] }[] }[]
    }
    expect(result.path_count).toBe(1)
    expect(result.paths[0].node_ids).toEqual(['repsol', 'sonatrach', 'algeria'])
    expect(result.paths[0].hops.map((h) => h.via[0].edge_id)).toEqual([
      'repsol->sonatrach:contractual',
      'sonatrach->algeria:equity',
    ])
  })

  it('returns no paths when the hop budget is too small', async () => {
    const run = await call(runner(), 'find_paths', {
      from_id: 'repsol',
      to_id: 'algeria',
      max_hops: 1,
    })
    expect((run.result as { path_count: number }).path_count).toBe(0)
  })
})

describe('get_metrics', () => {
  it('ranks chokepoints when no node is given', async () => {
    const run = await call(runner(), 'get_metrics', {})
    const ranked = (run.result as { chokepoints: { node_id: string }[] }).chokepoints
    /*
     * The fixture is a star-ish chain: cnmc — repsol — sonatrach — algeria.
     * Repsol sits on two of the shortest paths (cnmc to sonatrach, cnmc to
     * algeria) and Sonatrach on one (repsol to algeria), so that is the order.
     * The leaves are on none.
     */
    expect(ranked.map((c) => c.node_id)).toEqual(['repsol', 'sonatrach', 'algeria', 'cnmc'])
  })

  it('returns the metrics for one actor when a node is given', async () => {
    const run = await call(runner(), 'get_metrics', { node_id: 'repsol' })
    expect(run.result).toMatchObject({ node_id: 'repsol', degree: 2 })
  })
})

describe('filter_edges', () => {
  it('filters across the whole graph', async () => {
    const run = await call(runner(), 'filter_edges', { trajectory: 'deteriorating' })
    expect(run.result).toMatchObject({
      match_count: 1,
      relationships: [{ edge_id: 'repsol->cnmc:regulatory' }],
    })
  })
})

describe('get_timeline', () => {
  it('looks the relationship up by its logical edge id', async () => {
    const timeline = vi.fn(async () => [])
    await call(runner(timeline), 'get_timeline', { edge_id: 'repsol->cnmc:regulatory' })
    expect(timeline).toHaveBeenCalledWith('repsol', 'cnmc', 'regulatory')
  })

  it('says explicitly that there is no history rather than returning a bare empty list', async () => {
    const run = await call(runner(), 'get_timeline', { edge_id: 'repsol->cnmc:regulatory' })
    expect((run.result as { note?: string }).note).toMatch(/No recorded revisions/)
  })

  it('rejects an unknown edge id with a hint about the format', async () => {
    const run = await call(runner(), 'get_timeline', { edge_id: 'repsol-cnmc' })
    expect(run.isError).toBe(true)
    expect(JSON.stringify(run.result)).toMatch(/source->target:type/)
  })
})

describe('argument validation', () => {
  it('rejects an unknown tool by name', async () => {
    const run = await call(runner(), 'delete_everything', {})
    expect(run.isError).toBe(true)
    expect(JSON.stringify(run.result)).toMatch(/Unknown tool/)
  })

  it('rejects malformed JSON arguments', async () => {
    const run = await runner().execute('get_node', '{not json')
    expect(run.isError).toBe(true)
    expect(JSON.stringify(run.result)).toMatch(/not valid JSON/)
  })

  it('rejects a missing required argument, naming the field', async () => {
    const run = await call(runner(), 'get_node', {})
    expect(run.isError).toBe(true)
    expect(JSON.stringify(run.result)).toMatch(/node_id/)
  })

  it('rejects an out-of-range enum value', async () => {
    const run = await call(runner(), 'filter_edges', { state: 'furious' })
    expect(run.isError).toBe(true)
  })
})

describe('grounding set', () => {
  /**
   * This is what makes citation verification possible: every id the model has
   * been shown is recorded, so anything it cites that is not in here was
   * invented rather than retrieved.
   */
  it('records the ids returned by each call', async () => {
    const r = runner()
    await call(r, 'search_entities', { query: 'repsol' })
    expect([...r.grounding.nodeIds]).toEqual(['repsol'])
    expect([...r.grounding.edgeIds]).toEqual([])

    await call(r, 'get_relationships', { node_id: 'repsol' })
    expect([...r.grounding.edgeIds]).toEqual(
      expect.arrayContaining(['repsol->sonatrach:contractual', 'repsol->cnmc:regulatory']),
    )
    // The counterparties came back inside those edges, so they are grounded too.
    expect([...r.grounding.nodeIds]).toEqual(expect.arrayContaining(['sonatrach', 'cnmc']))
  })

  it('does not ground an id a failed call never returned', async () => {
    const r = runner()
    await call(r, 'get_node', { node_id: 'gazprom' })
    expect([...r.grounding.nodeIds]).toEqual([])
  })
})
