import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { sources } from '@/db/schema'
import type { RawDocument } from './source-adapter'

/**
 * Dedupes fetched documents against `sources` and inserts the new ones.
 *
 * Dedupe is on content_hash, deliberately not URL — the same story runs at
 * many URLs (syndication, AMP variants, query-string tracking), and the point
 * is to avoid re-triaging and re-extracting a story the pipeline has already
 * seen, not to avoid re-fetching a byte-identical link.
 */
export async function storeNewSources(
  docs: RawDocument[],
): Promise<Array<{ sourceId: string; doc: RawDocument }>> {
  const fresh: Array<{ sourceId: string; doc: RawDocument }> = []

  for (const doc of docs) {
    const [existing] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(eq(sources.contentHash, doc.contentHash))
      .limit(1)

    if (existing) continue

    const id = `src_${doc.contentHash.slice(0, 24)}`
    await db
      .insert(sources)
      .values({
        id,
        url: doc.url,
        title: doc.title,
        publisher: doc.publisher,
        publishedAt: doc.publishedAt,
        contentHash: doc.contentHash,
      })
      // Two docs can share a hash within the same batch (e.g. two adapters
      // returning the same story); the unique index is the real guard, this
      // just keeps a race from throwing.
      .onConflictDoNothing({ target: sources.contentHash })

    fresh.push({ sourceId: id, doc })
  }

  return fresh
}
