import type { LlmClient } from '@/lib/llm/client'
import type { SourceAdapter } from './source-adapter'
import { storeNewSources } from './sources-db'
import { loadEntityIndex, compileEntityIndex, prefilterDocuments } from './prefilter'
import { triageBatch } from './triage'
import { extractFromDocument } from './extract'
import { stageExtraction } from './stage'

/**
 * Orchestrates one ingestion run: fetch -> dedupe -> prefilter -> triage ->
 * extract -> resolve -> stage. Each stage is independently testable and
 * exported on its own (design spec §4); this module only sequences them.
 *
 * Checkpointing (spec §4.2's "rate limits / partial batch" failure mode) works
 * at the fetch/dedupe boundary: `storeNewSources` records every fetched
 * document immediately, so a full pipeline rerun with the same query never
 * re-spends a triage call on a document it has already seen. A document whose
 * EXTRACTION specifically fails is recorded in `errors` rather than retried by
 * a blind rerun — the cost table's separate `extract_retry` feature implies
 * re-extraction is meant to be a deliberate action against an already-stored
 * source, not something an automatic rerun does silently.
 *
 * Credits: this orchestrator does NOT meter credits. Per design spec §3.5,
 * `scripts/ingest.ts` runs under service credentials as an operator-triggered
 * batch job, distinct from a future `/api/ingest` route that would meter a
 * signed-in user. Wrap calls to this function in `withCredits` if that route
 * is ever built.
 *
 * Providers: `triageClient`/`extractClient` are typically `FallbackLlmClient`
 * instances (Groq primary, OpenRouter fallback per
 * docs/superpowers/specs/2026-08-06-groq-provider-fallback-design.md), but
 * this module has no dependency on that — any `LlmClient` works, which is
 * what keeps this testable with `MockLlmClient` alone.
 */

export interface IngestRunOptions {
  datasetId: string
  query: string
  sourceAdapter: SourceAdapter
  /**
   * Separate clients per role rather than one shared client: triage and
   * extraction have different fallback chains (each provider's cheap model
   * differs per role — see
   * docs/superpowers/specs/2026-08-06-groq-provider-fallback-design.md).
   * A caller using a single-provider client with no fallback can pass the
   * same client for both — a bare LlmClient still satisfies this.
   */
  triageClient: LlmClient
  extractClient: LlmClient
  /**
   * Model identifiers passed through to each completeStructured call. When
   * the client is a FallbackLlmClient these are metadata only — the client
   * substitutes its own chain entry's model — but a bare single-provider
   * client uses this value directly, so it must still be supplied.
   */
  triageModel: string
  extractModel: string
  maxDocs?: number
  maxLlmCalls?: number
  triageBatchSize?: number
}

export interface IngestRunResult {
  fetched: number
  newAfterDedupe: number
  matchedPrefilter: number
  triagedRelevant: number
  extracted: number
  staged: { pending: number; autoRejected: number }
  llmCalls: number
  stoppedByLlmCallLimit: boolean
  errors: Array<{ url: string; error: string }>
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export async function runIngest(opts: IngestRunOptions): Promise<IngestRunResult> {
  const maxDocs = opts.maxDocs ?? Number(process.env.INGEST_MAX_DOCS_PER_RUN ?? 100)
  const maxLlmCalls = opts.maxLlmCalls ?? Number(process.env.INGEST_MAX_LLM_CALLS_PER_RUN ?? 15)
  const batchSize = opts.triageBatchSize ?? Number(process.env.INGEST_TRIAGE_BATCH_SIZE ?? 20)

  const result: IngestRunResult = {
    fetched: 0,
    newAfterDedupe: 0,
    matchedPrefilter: 0,
    triagedRelevant: 0,
    extracted: 0,
    staged: { pending: 0, autoRejected: 0 },
    llmCalls: 0,
    stoppedByLlmCallLimit: false,
    errors: [],
  }

  // --- 1. FETCH + dedupe ---------------------------------------------------
  const raw = await opts.sourceAdapter.fetch(opts.query, { pageSize: maxDocs })
  result.fetched = raw.length

  const stored = await storeNewSources(raw)
  result.newAfterDedupe = stored.length
  if (stored.length === 0) return result

  // --- 2a. PREFILTER (deterministic, 0 LLM calls) ---------------------------
  const entityIndex = await loadEntityIndex(opts.datasetId)
  const compiled = compileEntityIndex(entityIndex)
  const candidates = prefilterDocuments(
    stored.map((s) => ({ ...s.doc, sourceId: s.sourceId })),
    compiled,
  )
  result.matchedPrefilter = candidates.length
  if (candidates.length === 0) return result

  // --- 2b. Batched TRIAGE ----------------------------------------------------
  const relevant: typeof candidates = []
  for (const batch of chunk(candidates, batchSize)) {
    if (result.llmCalls >= maxLlmCalls) {
      result.stoppedByLlmCallLimit = true
      break
    }
    const verdicts = await triageBatch(opts.triageClient, opts.triageModel, batch)
    result.llmCalls++
    for (const v of verdicts) if (v.relevant) relevant.push(v.doc)
  }
  result.triagedRelevant = relevant.length

  // --- 3. EXTRACT + 4. RESOLVE + 5. STAGE, one document at a time ----------
  for (const doc of relevant) {
    if (result.llmCalls >= maxLlmCalls) {
      result.stoppedByLlmCallLimit = true
      break
    }
    try {
      const extraction = await extractFromDocument(opts.extractClient, opts.extractModel, doc)
      result.llmCalls++
      result.extracted++

      const staged = await stageExtraction({
        datasetId: opts.datasetId,
        sourceId: doc.sourceId,
        sourceBody: doc.body,
        extraction,
        model: opts.extractModel,
        entityIndex,
      })
      if (staged.status === 'pending') result.staged.pending++
      if (staged.status === 'auto_rejected') result.staged.autoRejected++
    } catch (err) {
      // Deliberately does not re-throw: one bad document must not abort the
      // rest of the batch (spec §4.2). The source row written at dedupe time
      // stays, so this document surfaces here on every rerun until a
      // dedicated retry addresses it, rather than silently vanishing.
      result.errors.push({
        url: doc.url,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return result
}
