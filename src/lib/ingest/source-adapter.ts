/**
 * A document fetched from a news source, before any model has looked at it.
 */
export interface RawDocument {
  url: string
  title: string
  publisher: string
  publishedAt: Date | null
  /** Plain text, tags stripped. Empty for a metadata_only source. */
  body: string
  /** Deterministic content fingerprint — the seam dedupe hangs off. */
  contentHash: string
}

/**
 * Sources differ in a way the pipeline must model explicitly (design spec
 * §4.1): a metadata_only source can trigger the prefilter and flag an entity
 * for attention, but it can never produce an evidence-quoted proposal, because
 * there is no body text to quote from. Extraction only ever runs on
 * full_text documents — see src/lib/ingest/pipeline.ts.
 */
export type SourceKind = 'full_text' | 'metadata_only'

export interface SourceAdapter {
  id: string
  kind: SourceKind
  fetch(query: string, opts?: { pageSize?: number }): Promise<RawDocument[]>
}

/** SHA-256 of the normalised body (or title, for metadata-only sources). */
export async function hashContent(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input.trim().toLowerCase())
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Strips HTML tags and collapses whitespace. The Guardian returns body as HTML. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/\s+/g, ' ')
    .trim()
}
