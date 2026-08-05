import { describe, it, expect } from 'vitest'
import raw from '@/data/stakeholders.json'
import type { GraphData } from '../types'

const graph = raw as unknown as GraphData & { disclaimer: string }

const CATEGORIES = [
  'client',
  'government',
  'regulator',
  'competitor',
  'supplier',
  'customer',
  'financier',
  'union',
  'ngo',
  'individual',
]
const REGIONS = ['Iberia', 'North Africa', 'Latin America', 'Europe', 'North America']
const STATES = ['hostile', 'strained', 'transactional', 'stable', 'cooperative']
const TRAJECTORIES = ['deteriorating', 'stable', 'improving']
const REL_TYPES = [
  'contractual',
  'regulatory',
  'equity',
  'financing',
  'adversarial',
  'political',
  'advocacy',
  'labour',
]
const DIRECTIONS = ['mutual', 'source-depends', 'target-depends']
const CONFIDENCE = ['high', 'medium', 'low']

/**
 * The dataset is hand-authored, so these are the guardrails that stop a typo in
 * a 700-line JSON file from silently producing an edge that points nowhere or a
 * state string the renderer has no colour for.
 */
describe('dataset shape', () => {
  it("sits inside the brief's 25-40 node range", () => {
    expect(graph.nodes.length).toBeGreaterThanOrEqual(25)
    expect(graph.nodes.length).toBeLessThanOrEqual(40)
  })

  it('names a client that exists as a node', () => {
    expect(graph.nodes.some((n) => n.id === graph.client)).toBe(true)
  })

  it('carries the illustrative-data disclaimer', () => {
    expect(graph.disclaimer).toMatch(/invented/i)
  })

  it('has exactly one node with category "client"', () => {
    expect(graph.nodes.filter((n) => n.category === 'client')).toHaveLength(1)
  })

  it('has unique node ids', () => {
    const ids = graph.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('node fields', () => {
  it.each(['category', 'region'] as const)('uses only known %s values', (field) => {
    const allowed = field === 'category' ? CATEGORIES : REGIONS
    const bad = graph.nodes.filter((n) => !allowed.includes(n[field]))
    expect(bad.map((n) => `${n.id}:${n[field]}`)).toEqual([])
  })

  it('keeps influence within 0-100', () => {
    const bad = graph.nodes.filter((n) => n.influence < 0 || n.influence > 100)
    expect(bad.map((n) => n.id)).toEqual([])
  })

  it('gives every node a non-empty name, role and description', () => {
    const bad = graph.nodes.filter(
      (n) => !n.name?.trim() || !n.role?.trim() || !n.description?.trim(),
    )
    expect(bad.map((n) => n.id)).toEqual([])
  })
})

describe('edge referential integrity', () => {
  const ids = new Set(graph.nodes.map((n) => n.id))

  it('has no dangling source or target references', () => {
    const bad = graph.edges
      .filter((e) => !ids.has(e.source) || !ids.has(e.target))
      .map((e) => `${e.source}->${e.target}`)
    expect(bad).toEqual([])
  })

  it('has no self-loops', () => {
    const bad = graph.edges.filter((e) => e.source === e.target)
    expect(bad).toEqual([])
  })

  it('leaves no node orphaned', () => {
    const touched = new Set(graph.edges.flatMap((e) => [e.source, e.target]))
    const orphans = graph.nodes.filter((n) => !touched.has(n.id)).map((n) => n.id)
    expect(orphans).toEqual([])
  })

  it('has no duplicate edges of the same type between the same pair', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const e of graph.edges) {
      const key = [e.source, e.target].sort().join('|') + ':' + e.type
      if (seen.has(key)) dupes.push(key)
      seen.add(key)
    }
    expect(dupes).toEqual([])
  })
})

describe('edge fields', () => {
  const cases = [
    ['state', STATES],
    ['trajectory', TRAJECTORIES],
    ['type', REL_TYPES],
    ['direction', DIRECTIONS],
    ['confidence', CONFIDENCE],
  ] as const

  it.each(cases)('uses only known %s values', (field, allowed) => {
    const bad = graph.edges
      .filter((e) => !(allowed as readonly string[]).includes(e[field]))
      .map((e) => `${e.source}->${e.target}:${e[field]}`)
    expect(bad).toEqual([])
  })

  it('keeps strength within 0-100', () => {
    const bad = graph.edges.filter((e) => e.strength < 0 || e.strength > 100)
    expect(bad.map((e) => `${e.source}->${e.target}`)).toEqual([])
  })

  it('gives every edge an exposure, narrative and dated last event', () => {
    const bad = graph.edges.filter(
      (e) =>
        !e.exposure?.trim() ||
        !e.narrative?.trim() ||
        !e.lastEvent?.summary?.trim() ||
        !/^\d{4}-\d{2}$/.test(e.lastEvent?.date ?? ''),
    )
    expect(bad.map((e) => `${e.source}->${e.target}`)).toEqual([])
  })

  it('does not date a relationship start in the future', () => {
    const year = Number(graph.asOf.slice(0, 4))
    const bad = graph.edges.filter((e) => e.since > year)
    expect(bad.map((e) => `${e.source}->${e.target}:${e.since}`)).toEqual([])
  })
})

/**
 * These are the claims the README makes about the dataset. If someone prunes
 * the data and quietly turns the graph back into a star, the write-up becomes
 * wrong — so the claims are asserted rather than trusted.
 */
describe('analytical structure claims', () => {
  it('is not a hub-and-spoke star: many edges avoid the client entirely', () => {
    const nonHub = graph.edges.filter(
      (e) => e.source !== graph.client && e.target !== graph.client,
    )
    expect(nonHub.length).toBeGreaterThanOrEqual(10)
  })

  it('models at least one pair holding two distinct relationships', () => {
    const pairs = new Map<string, number>()
    for (const e of graph.edges) {
      const k = [e.source, e.target].sort().join('|')
      pairs.set(k, (pairs.get(k) ?? 0) + 1)
    }
    expect([...pairs.values()].some((n) => n > 1)).toBe(true)
  })

  it('exercises the full range of relationship states and trajectories', () => {
    expect(new Set(graph.edges.map((e) => e.state)).size).toBe(STATES.length)
    expect(new Set(graph.edges.map((e) => e.trajectory)).size).toBe(TRAJECTORIES.length)
  })

  it('covers every actor category', () => {
    expect(new Set(graph.nodes.map((n) => n.category)).size).toBe(CATEGORIES.length)
  })
})
