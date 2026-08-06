import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { createGuardianAdapter } from '../guardian'

function fixtureResponse(results: unknown[], status = 'ok') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ response: { status, total: results.length, results } }),
    text: async () => JSON.stringify({ response: { status } }),
  }
}

const RESULT = {
  id: 'world/2026/jan/01/repsol-sonatrach',
  webUrl: 'https://www.theguardian.com/world/2026/jan/01/repsol-sonatrach',
  webTitle: 'Repsol and Sonatrach conclude gas price review',
  sectionName: 'Business',
  webPublicationDate: '2026-01-01T09:00:00Z',
  fields: {
    body: '<p>Repsol and <b>Sonatrach</b> concluded a price review.&nbsp;It narrows terms.</p>',
    trailText: 't',
    byline: 'b',
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Guardian adapter', () => {
  it('is declared as full_text', () => {
    const adapter = createGuardianAdapter('key')
    expect(adapter.kind).toBe('full_text')
  })

  it('strips HTML from the body', async () => {
    vi.mocked(fetch).mockResolvedValue(fixtureResponse([RESULT]) as unknown as Response)
    const [doc] = await createGuardianAdapter('key').fetch('Repsol')
    expect(doc.body).not.toMatch(/<[^>]+>/)
    expect(doc.body).toContain('Repsol and Sonatrach concluded a price review.')
  })

  it('maps fields to the RawDocument shape', async () => {
    vi.mocked(fetch).mockResolvedValue(fixtureResponse([RESULT]) as unknown as Response)
    const [doc] = await createGuardianAdapter('key').fetch('Repsol')
    expect(doc.url).toBe(RESULT.webUrl)
    expect(doc.title).toBe(RESULT.webTitle)
    expect(doc.publisher).toBe('The Guardian')
    expect(doc.publishedAt?.toISOString()).toBe('2026-01-01T09:00:00.000Z')
  })

  it('computes a stable content hash', async () => {
    vi.mocked(fetch).mockResolvedValue(fixtureResponse([RESULT]) as unknown as Response)
    const [doc] = await createGuardianAdapter('key').fetch('Repsol')
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('skips results with no body', async () => {
    const empty = { ...RESULT, fields: { body: '' } }
    vi.mocked(fetch).mockResolvedValue(fixtureResponse([empty]) as unknown as Response)
    expect(await createGuardianAdapter('key').fetch('Repsol')).toEqual([])
  })

  it('sends the api key as a query parameter', async () => {
    vi.mocked(fetch).mockResolvedValue(fixtureResponse([]) as unknown as Response)
    await createGuardianAdapter('secret-key').fetch('Repsol')
    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as URL
    expect(calledUrl.toString()).toContain('api-key=secret-key')
  })

  it('caps page size at 50, the Guardian API limit', async () => {
    vi.mocked(fetch).mockResolvedValue(fixtureResponse([]) as unknown as Response)
    await createGuardianAdapter('key').fetch('Repsol', { pageSize: 500 })
    const calledUrl = vi.mocked(fetch).mock.calls[0][0] as URL
    expect(calledUrl.searchParams.get('page-size')).toBe('50')
  })

  it('throws on a non-ok HTTP response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    } as unknown as Response)
    await expect(createGuardianAdapter('key').fetch('Repsol')).rejects.toThrow(/500/)
  })

  it('throws when the API reports a non-ok status', async () => {
    vi.mocked(fetch).mockResolvedValue(fixtureResponse([], 'error') as unknown as Response)
    await expect(createGuardianAdapter('key').fetch('Repsol')).rejects.toThrow(/status/i)
  })
})
