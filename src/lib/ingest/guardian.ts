import type { SourceAdapter, RawDocument } from './source-adapter'
import { hashContent, stripHtml } from './source-adapter'

/**
 * Guardian Open Platform — the only full_text source in scope for Phase 5 (see
 * design spec §4.1). Free developer key: 5,000 calls/day, 12/sec, non-commercial
 * use only. `fields.body` is returned as HTML, so every document is stripped
 * before it reaches the pipeline.
 *
 * The "24 hour" clause sometimes cited for this API is a polling requirement,
 * not a deletion requirement — Guardian staff clarify it means consumers must
 * re-check for updates/takedowns, not purge stored content. Storing an evidence
 * quote plus source URL is compatible with the terms.
 */
interface GuardianSearchResult {
  id: string
  webUrl: string
  webTitle: string
  sectionName: string
  webPublicationDate: string
  fields?: { body?: string; trailText?: string; byline?: string }
}

interface GuardianResponse {
  response: {
    status: string
    total: number
    results: GuardianSearchResult[]
  }
}

export function createGuardianAdapter(apiKey: string): SourceAdapter {
  return {
    id: 'guardian',
    kind: 'full_text',

    async fetch(query, opts): Promise<RawDocument[]> {
      const pageSize = Math.min(opts?.pageSize ?? 50, 50) // Guardian's own cap
      const url = new URL('https://content.guardianapis.com/search')
      url.searchParams.set('q', query)
      url.searchParams.set('show-fields', 'body,trailText,byline')
      url.searchParams.set('page-size', String(pageSize))
      url.searchParams.set('api-key', apiKey)

      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Guardian API returned ${res.status}: ${await res.text()}`)
      }

      const data = (await res.json()) as GuardianResponse
      if (data.response.status !== 'ok') {
        throw new Error(`Guardian API status: ${data.response.status}`)
      }

      const docs: RawDocument[] = []
      for (const r of data.response.results) {
        const body = stripHtml(r.fields?.body ?? '')
        if (!body) continue // skip results with no article body to extract from
        docs.push({
          url: r.webUrl,
          title: r.webTitle,
          publisher: 'The Guardian',
          publishedAt: r.webPublicationDate ? new Date(r.webPublicationDate) : null,
          body,
          contentHash: await hashContent(body),
        })
      }
      return docs
    },
  }
}

export function getGuardianAdapter(): SourceAdapter {
  const apiKey = process.env.GUARDIAN_API_KEY
  if (!apiKey) {
    throw new Error(
      'GUARDIAN_API_KEY is not set. Copy .env.example to .env.local and fill it in.',
    )
  }
  return createGuardianAdapter(apiKey)
}
