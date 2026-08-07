import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createTestDb, type TestDb } from '@/db/__tests__/helpers'
import { datasets, nodes, entityAliases } from '@/db/schema'
import { compileEntityIndex, prefilterDocuments, type EntityIndexEntry } from '../prefilter'

let db: TestDb
let currentDb: TestDb

vi.mock('@/db/client', () => ({
  get db() {
    return currentDb
  },
}))

beforeEach(async () => {
  ;({ db } = await createTestDb())
  currentDb = db
})

async function prefilter() {
  return import('../prefilter')
}

function doc(title: string, body: string) {
  return { title, body }
}

describe('compileEntityIndex / prefilterDocuments (pure)', () => {
  const index: EntityIndexEntry[] = [
    { nodeId: 'sonatrach', matchers: ['Sonatrach', 'Sonatrach SPA', 'SH'] },
    { nodeId: 'repsol', matchers: ['Repsol'] },
  ]

  it('matches a document mentioning a tracked entity', () => {
    const compiled = compileEntityIndex(index)
    const [result] = prefilterDocuments(
      [doc('News', 'Repsol announced a new contract.')],
      compiled,
    )
    expect(result.matchedNodeIds).toEqual(['repsol'])
  })

  it('drops a document mentioning nothing tracked', () => {
    const compiled = compileEntityIndex(index)
    expect(prefilterDocuments([doc('News', 'Unrelated company news.')], compiled)).toEqual([])
  })

  it('matches an alias as well as the canonical name', () => {
    const compiled = compileEntityIndex(index)
    const [result] = prefilterDocuments(
      [doc('News', 'Sonatrach SPA signed a new deal.')],
      compiled,
    )
    expect(result.matchedNodeIds).toEqual(['sonatrach'])
  })

  it('is case-insensitive', () => {
    const compiled = compileEntityIndex(index)
    const [result] = prefilterDocuments([doc('news', 'REPSOL raised prices.')], compiled)
    expect(result.matchedNodeIds).toEqual(['repsol'])
  })

  it('respects word boundaries — does not match inside an unrelated word', () => {
    const compiled = compileEntityIndex(index)
    // "SH" as a short alias must not fire on "cash" or "wish".
    expect(prefilterDocuments([doc('t', 'The cash flow improved.')], compiled)).toEqual([])
    expect(prefilterDocuments([doc('t', 'I wish it were true.')], compiled)).toEqual([])
  })

  it('collects every matched entity, not just the first', () => {
    const compiled = compileEntityIndex(index)
    const [result] = prefilterDocuments(
      [doc('t', 'Repsol and Sonatrach concluded a review.')],
      compiled,
    )
    expect(new Set(result.matchedNodeIds)).toEqual(new Set(['repsol', 'sonatrach']))
  })

  it('checks both title and body', () => {
    const compiled = compileEntityIndex(index)
    const [result] = prefilterDocuments(
      [doc('Repsol update', 'Nothing relevant here.')],
      compiled,
    )
    expect(result.matchedNodeIds).toEqual(['repsol'])
  })

  it('handles an empty index by matching nothing', () => {
    const compiled = compileEntityIndex([])
    expect(prefilterDocuments([doc('t', 'Repsol news.')], compiled)).toEqual([])
  })

  it('ignores blank matcher strings rather than matching everything', () => {
    const compiled = compileEntityIndex([{ nodeId: 'x', matchers: ['', '  ', 'Real Name'] }])
    expect(prefilterDocuments([doc('t', 'totally unrelated text')], compiled)).toEqual([])
  })
})

describe('loadEntityIndex (DB-backed)', () => {
  beforeEach(async () => {
    await db
      .insert(datasets)
      .values({ id: 'live', slug: 'live', name: 'Live', kind: 'sourced' })
    await db.insert(nodes).values({
      id: 'sonatrach',
      datasetId: 'live',
      name: 'Sonatrach',
      category: 'supplier',
      country: 'DZ',
      region: 'North Africa',
      influence: 50,
      role: 'r',
      description: 'd',
      keyPeople: [],
    })
    await db.insert(entityAliases).values([
      { id: 'a1', datasetId: 'live', nodeId: 'sonatrach', alias: 'Sonatrach SPA' },
      { id: 'a2', datasetId: 'live', nodeId: 'sonatrach', alias: 'SH' },
    ])
  })

  it('includes the canonical name and every alias', async () => {
    const { loadEntityIndex } = await prefilter()
    const index = await loadEntityIndex('live')
    expect(index).toHaveLength(1)
    expect(new Set(index[0].matchers)).toEqual(new Set(['Sonatrach', 'Sonatrach SPA', 'SH']))
  })

  it('scopes to the given dataset', async () => {
    await db
      .insert(datasets)
      .values({ id: 'other', slug: 'other', name: 'Other', kind: 'sourced' })
    const { loadEntityIndex } = await prefilter()
    expect(await loadEntityIndex('other')).toEqual([])
  })

  it('composes end to end with the pure matcher', async () => {
    const { loadEntityIndex, compileEntityIndex, prefilterDocuments } = await prefilter()
    const compiled = compileEntityIndex(await loadEntityIndex('live'))
    const [result] = prefilterDocuments(
      [doc('t', 'The Algerian producer SH raised output.')],
      compiled,
    )
    expect(result.matchedNodeIds).toEqual(['sonatrach'])
  })
})
