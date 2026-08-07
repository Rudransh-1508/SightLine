import { describe, it, expect, vi, beforeEach } from 'vitest'

import { createTestDb, type TestDb } from '@/db/__tests__/helpers'
import { datasets, nodes, proposals } from '@/db/schema'
import { MockLlmClient } from '@/lib/llm/mock'
import type { SourceAdapter, RawDocument } from '../source-adapter'
import { hashContent } from '../source-adapter'

let db: TestDb
let currentDb: TestDb

vi.mock('@/db/client', () => ({
  get db() {
    return currentDb
  },
}))

const LIVE = 'live'

beforeEach(async () => {
  ;({ db } = await createTestDb())
  currentDb = db
  await db.insert(datasets).values({ id: LIVE, slug: LIVE, name: 'Live', kind: 'sourced' })
  await db.insert(nodes).values([
    {
      id: 'repsol',
      datasetId: LIVE,
      name: 'Repsol',
      category: 'client',
      country: 'ES',
      region: 'Iberia',
      influence: 100,
      role: 'r',
      description: 'd',
      keyPeople: [],
    },
    {
      id: 'sonatrach',
      datasetId: LIVE,
      name: 'Sonatrach',
      category: 'supplier',
      country: 'DZ',
      region: 'North Africa',
      influence: 50,
      role: 'r',
      description: 'd',
      keyPeople: [],
    },
  ])
})

async function pipeline() {
  return import('../pipeline')
}

async function doc(
  over: Partial<RawDocument> & { body: string; title?: string },
): Promise<RawDocument> {
  return {
    url: over.url ?? `https://example.com/${Math.random()}`,
    title: over.title ?? 'Story',
    publisher: over.publisher ?? 'The Guardian',
    publishedAt: over.publishedAt ?? new Date('2026-01-01'),
    body: over.body,
    contentHash: over.contentHash ?? (await hashContent(over.body)),
  }
}

function fakeAdapter(docs: RawDocument[]): SourceAdapter {
  return { id: 'fake', kind: 'full_text', fetch: async () => docs }
}

const RELEVANT_BODY = 'Repsol and Sonatrach concluded a price review in May.'
const IRRELEVANT_BODY = 'A completely unrelated story about the weather.'

const EXTRACTION = {
  found: true,
  sourceEntity: 'Repsol',
  targetEntity: 'Sonatrach',
  relationshipType: 'contractual',
  direction: 'source-depends',
  strength: 70,
  state: 'strained',
  trajectory: 'improving',
  exposure: 'gas supply',
  narrative: 'Price terms narrowed.',
  confidence: 'medium',
  evidenceQuote: 'Repsol and Sonatrach concluded a price review',
}

describe('runIngest — happy path', () => {
  it('carries one relevant document through every stage to a staged proposal', async () => {
    const { runIngest } = await pipeline()
    const client = new MockLlmClient()
      .respondWith({ results: [{ index: 0, relevant: true }] }) // triage
      .respondWith(EXTRACTION) // extract

    const result = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter([await doc({ body: RELEVANT_BODY })]),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
    })

    expect(result.fetched).toBe(1)
    expect(result.newAfterDedupe).toBe(1)
    expect(result.matchedPrefilter).toBe(1)
    expect(result.triagedRelevant).toBe(1)
    expect(result.extracted).toBe(1)
    expect(result.staged.pending).toBe(1)
    expect(result.llmCalls).toBe(2) // one triage batch + one extraction

    expect(await db.select().from(proposals)).toHaveLength(1)
  })
})

describe('runIngest — the prefilter saves LLM calls', () => {
  it('never calls the model for a document mentioning no tracked entity', async () => {
    const { runIngest } = await pipeline()
    const client = new MockLlmClient() // no responses queued — must never be called

    const result = await runIngest({
      datasetId: LIVE,
      query: 'x',
      sourceAdapter: fakeAdapter([await doc({ body: IRRELEVANT_BODY })]),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
    })

    expect(result.matchedPrefilter).toBe(0)
    expect(result.llmCalls).toBe(0)
    expect(client.callCount).toBe(0)
  })
})

describe('runIngest — triage saves extraction calls', () => {
  it('does not extract a document triage marked irrelevant', async () => {
    const { runIngest } = await pipeline()
    const client = new MockLlmClient().respondWith({ results: [{ index: 0, relevant: false }] })

    const result = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter([await doc({ body: RELEVANT_BODY })]),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
    })

    expect(result.triagedRelevant).toBe(0)
    expect(result.extracted).toBe(0)
    expect(result.llmCalls).toBe(1) // triage only
  })
})

describe('runIngest — batching', () => {
  it('makes exactly one triage call for a batch under the size limit', async () => {
    const { runIngest } = await pipeline()
    const docs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        doc({ body: `${RELEVANT_BODY} (variant ${i})`, url: `https://example.com/${i}` }),
      ),
    )
    const client = new MockLlmClient().respondWith({
      results: docs.map((_, i) => ({ index: i, relevant: false })),
    })

    const result = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter(docs),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
      triageBatchSize: 20,
    })

    expect(result.matchedPrefilter).toBe(5)
    expect(result.llmCalls).toBe(1)
  })

  it('splits into multiple triage calls when the batch exceeds the size limit', async () => {
    const { runIngest } = await pipeline()
    const docs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        doc({ body: `${RELEVANT_BODY} (variant ${i})`, url: `https://example.com/${i}` }),
      ),
    )
    const client = new MockLlmClient()
      .respondWith({
        results: [
          { index: 0, relevant: false },
          { index: 1, relevant: false },
        ],
      })
      .respondWith({
        results: [
          { index: 0, relevant: false },
          { index: 1, relevant: false },
        ],
      })
      .respondWith({ results: [{ index: 0, relevant: false }] })

    const result = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter(docs),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
      triageBatchSize: 2,
    })

    expect(result.llmCalls).toBe(3) // ceil(5/2)
  })
})

/**
 * The most important test in this file: the free OpenRouter tier allows only
 * 50 requests/day (design spec §3.4.1). If this guard doesn't actually stop
 * the pipeline, a single run can silently exhaust the entire day's quota.
 */
describe('runIngest — LLM call budget', () => {
  it('stops before exceeding maxLlmCalls and reports why', async () => {
    const { runIngest } = await pipeline()
    const docs = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        doc({ body: `${RELEVANT_BODY} (variant ${i})`, url: `https://example.com/${i}` }),
      ),
    )
    // Only one triage response queued; a second attempt would throw
    // "no queued response" — proving the pipeline never makes that call.
    const client = new MockLlmClient().respondWith({
      results: [{ index: 0, relevant: false }],
    })

    const result = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter(docs),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
      triageBatchSize: 1, // forces 3 separate triage calls, only 1 allowed
      maxLlmCalls: 1,
    })

    expect(result.llmCalls).toBe(1)
    expect(result.stoppedByLlmCallLimit).toBe(true)
  })

  it('the guard also applies to extraction calls, not just triage', async () => {
    const { runIngest } = await pipeline()
    const docs = await Promise.all(
      Array.from({ length: 2 }, (_, i) =>
        doc({ body: `${RELEVANT_BODY} (variant ${i})`, url: `https://example.com/${i}` }),
      ),
    )
    const client = new MockLlmClient()
      .respondWith({
        results: [
          { index: 0, relevant: true },
          { index: 1, relevant: true },
        ],
      })
      .respondWith(EXTRACTION) // only one extraction allowed to run

    const result = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter(docs),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
      maxLlmCalls: 2, // 1 triage + 1 extraction, then stop
    })

    expect(result.extracted).toBe(1)
    expect(result.stoppedByLlmCallLimit).toBe(true)
    expect(result.llmCalls).toBe(2)
  })
})

describe('runIngest — dedupe as checkpointing', () => {
  it('a rerun with the same document makes no further LLM calls', async () => {
    const { runIngest } = await pipeline()
    const sameDoc = await doc({ body: RELEVANT_BODY })

    const client1 = new MockLlmClient()
      .respondWith({ results: [{ index: 0, relevant: true }] })
      .respondWith(EXTRACTION)
    await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter([sameDoc]),
      triageClient: client1,
      extractClient: client1,
      triageModel: 't',
      extractModel: 'e',
    })

    const client2 = new MockLlmClient() // nothing queued
    const result2 = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter([sameDoc]),
      triageClient: client2,
      extractClient: client2,
      triageModel: 't',
      extractModel: 'e',
    })

    expect(result2.newAfterDedupe).toBe(0)
    expect(result2.llmCalls).toBe(0)
    expect(await db.select().from(proposals)).toHaveLength(1) // not duplicated
  })
})

describe('runIngest — per-document error isolation', () => {
  it('one failing extraction does not stop the rest of the batch', async () => {
    const { runIngest } = await pipeline()
    const docs = await Promise.all([
      doc({ body: `${RELEVANT_BODY} (a)`, url: 'https://example.com/a' }),
      doc({ body: `${RELEVANT_BODY} (b)`, url: 'https://example.com/b' }),
    ])
    const client = new MockLlmClient()
      .respondWith({
        results: [
          { index: 0, relevant: true },
          { index: 1, relevant: true },
        ],
      })
      .failWith(new Error('provider hiccup'))
      .respondWith(EXTRACTION)

    const result = await runIngest({
      datasetId: LIVE,
      query: 'Repsol',
      sourceAdapter: fakeAdapter(docs),
      triageClient: client,
      extractClient: client,
      triageModel: 't',
      extractModel: 'e',
    })

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].error).toMatch(/provider hiccup/)
    expect(result.extracted).toBe(1) // the second document still succeeded
    expect(result.staged.pending).toBe(1)
  })
})
