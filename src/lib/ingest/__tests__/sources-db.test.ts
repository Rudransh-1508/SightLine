import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createTestDb, type TestDb } from '@/db/__tests__/helpers'
import { sources } from '@/db/schema'
import type { RawDocument } from '../source-adapter'

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

async function sourcesDb() {
  return import('../sources-db')
}

function doc(over: Partial<RawDocument> = {}): RawDocument {
  return {
    url: 'https://example.com/a',
    title: 'A story',
    publisher: 'The Guardian',
    publishedAt: new Date('2026-01-01'),
    body: 'body text',
    contentHash: 'hash-a',
    ...over,
  }
}

describe('storeNewSources', () => {
  it('inserts a new document and returns it', async () => {
    const { storeNewSources } = await sourcesDb()
    const result = await storeNewSources([doc()])

    expect(result).toHaveLength(1)
    expect(result[0].doc.contentHash).toBe('hash-a')
    expect(await db.select().from(sources)).toHaveLength(1)
  })

  it('skips a document whose content_hash already exists', async () => {
    const { storeNewSources } = await sourcesDb()
    await storeNewSources([doc()])
    const second = await storeNewSources([doc({ url: 'https://mirror.example.com/a' })])

    expect(second).toHaveLength(0)
    expect(await db.select().from(sources)).toHaveLength(1)
  })

  it('dedupes by content, not URL', async () => {
    const { storeNewSources } = await sourcesDb()
    // Same story, syndicated at a different URL — one content_hash.
    const result = await storeNewSources([
      doc({ url: 'https://a.example.com/story' }),
      doc({ url: 'https://amp.example.com/story' }),
    ])
    expect(result).toHaveLength(1)
    expect(await db.select().from(sources)).toHaveLength(1)
  })

  it('stores distinct documents separately', async () => {
    const { storeNewSources } = await sourcesDb()
    const result = await storeNewSources([
      doc({ contentHash: 'h1' }),
      doc({ contentHash: 'h2' }),
    ])
    expect(result).toHaveLength(2)
    expect(await db.select().from(sources)).toHaveLength(2)
  })

  it('returns nothing for an empty input', async () => {
    const { storeNewSources } = await sourcesDb()
    expect(await storeNewSources([])).toEqual([])
  })
})
