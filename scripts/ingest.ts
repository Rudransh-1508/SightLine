import { config } from 'dotenv'
config({ path: ['.env.local', '.env'] })

import { getGuardianAdapter } from '../src/lib/ingest/guardian'
import { getGroqClient } from '../src/lib/llm/groq'
import { getOpenRouterClient } from '../src/lib/llm/openrouter'
import { FallbackLlmClient } from '../src/lib/llm/fallback'
import { runIngest } from '../src/lib/ingest/pipeline'

/**
 * CLI entrypoint: `pnpm run ingest -- <dataset> <query>`.
 *
 * Runs under service credentials (design spec §3.5) — not metered against any
 * user's credit balance. Respects INGEST_MAX_DOCS_PER_RUN,
 * INGEST_MAX_LLM_CALLS_PER_RUN and INGEST_TRIAGE_BATCH_SIZE from the
 * environment; see .env.example for what each guards against.
 *
 * Provider order: Groq primary, OpenRouter fallback — see
 * docs/superpowers/specs/2026-08-06-groq-provider-fallback-design.md.
 * Triage and extraction get their own FallbackLlmClient instances because
 * each provider's cheap model differs per role.
 */
async function main() {
  /*
   * `pnpm run ingest -- live "query"` forwards the `--` separator itself as
   * an argument, so a naive slice(2) reads the dataset as "--" and silently
   * ingests into a non-existent dataset (observed live: reported
   * `Ingesting into "--"`, matched 0 entities, made 0 LLM calls, and looked
   * like a legitimate empty result). Dropping leading separators makes both
   * `pnpm run ingest live "q"` and `pnpm run ingest -- live "q"` work.
   */
  const args = process.argv.slice(2).filter((a) => a !== '--')
  const [datasetId, ...queryParts] = args
  const query = queryParts.join(' ')

  if (!datasetId || !query) {
    console.error('Usage: pnpm run ingest <dataset-id> <query>')
    console.error('Example: pnpm run ingest live "Repsol Sonatrach"')
    process.exit(1)
  }

  console.log(`Ingesting into "${datasetId}" for query "${query}"...`)

  const groqTriageModel = requireEnv('GROQ_TRIAGE_MODEL')
  const groqExtractModel = requireEnv('GROQ_EXTRACT_MODEL')
  const openrouterTriageModel = requireEnv('OPENROUTER_TRIAGE_MODEL')
  const openrouterExtractModel = requireEnv('OPENROUTER_EXTRACT_MODEL')

  const triageClient = new FallbackLlmClient([
    { client: getGroqClient(), model: groqTriageModel, label: 'groq' },
    { client: getOpenRouterClient(), model: openrouterTriageModel, label: 'openrouter' },
  ])
  const extractClient = new FallbackLlmClient([
    { client: getGroqClient(), model: groqExtractModel, label: 'groq' },
    { client: getOpenRouterClient(), model: openrouterExtractModel, label: 'openrouter' },
  ])

  const result = await runIngest({
    datasetId,
    query,
    sourceAdapter: getGuardianAdapter(),
    triageClient,
    extractClient,
    // Metadata passed through to each call; the FallbackLlmClient chain
    // substitutes its own model per entry when it actually dispatches, but
    // the pipeline's request shape still requires a value here.
    triageModel: groqTriageModel,
    extractModel: groqExtractModel,
  })

  console.log('')
  console.log('fetched            ', result.fetched)
  console.log('new after dedupe   ', result.newAfterDedupe)
  console.log('matched prefilter  ', result.matchedPrefilter)
  console.log('triaged relevant   ', result.triagedRelevant)
  console.log('extracted          ', result.extracted)
  console.log('staged pending     ', result.staged.pending)
  console.log('staged auto-reject ', result.staged.autoRejected)
  console.log('LLM calls made     ', result.llmCalls)
  if (triageClient.exhaustedProviders.length > 0) {
    console.log('triage fell back, exhausted:', triageClient.exhaustedProviders.join(', '))
  }
  if (extractClient.exhaustedProviders.length > 0) {
    console.log('extract fell back, exhausted:', extractClient.exhaustedProviders.join(', '))
  }
  if (result.stoppedByLlmCallLimit) {
    console.log('⚠ stopped early — hit INGEST_MAX_LLM_CALLS_PER_RUN')
  }
  if (result.errors.length > 0) {
    console.log('')
    console.log(`${result.errors.length} document(s) failed and were skipped:`)
    for (const e of result.errors) console.log(`  ${e.url}: ${e.error}`)
  }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local.`)
  return value
}

main().catch((err) => {
  console.error('ingest failed:', err)
  process.exit(1)
})
