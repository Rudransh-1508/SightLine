import type { LlmClient, StructuredCompletionParams } from './client'

export interface ChainEntry {
  client: LlmClient
  model: string
  /** Used in logging and error messages — "groq", "openrouter", etc. */
  label: string
}

export class AllProvidersExhaustedError extends Error {
  constructor(readonly tried: string[]) {
    super(`All providers exhausted or failed: ${tried.join(', ')}`)
    this.name = 'AllProvidersExhaustedError'
  }
}

/** True only for an HTTP 429 — the one condition that should trigger fallback. */
function isRateLimitError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const status = (err as { status?: unknown }).status
  return status === 429
}

/**
 * Tries a chain of providers in order, falling back only on rate-limit errors.
 *
 * Design spec 2026-08-06-groq-provider-fallback-design.md §3.1: a
 * schema-validation failure or any other error propagates immediately rather
 * than triggering fallback. Silently retrying a bad prompt against a second
 * provider would hide a real bug behind an apparently successful run, and
 * would make it unclear which provider actually produced a given result.
 * Capacity problems get failover; correctness problems get surfaced.
 *
 * Exhaustion is tracked in memory for the lifetime of this instance — correct
 * for the current CLI-only usage (one process per `pnpm run ingest`
 * invocation), not for a future serverless route. See the design spec §4.
 */
export class FallbackLlmClient implements LlmClient {
  private readonly exhausted = new Set<string>()

  constructor(private readonly chain: ChainEntry[]) {
    if (chain.length === 0) {
      throw new Error('FallbackLlmClient requires at least one chain entry')
    }
  }

  async completeStructured(params: StructuredCompletionParams): Promise<unknown> {
    const tried: string[] = []

    for (const entry of this.chain) {
      if (this.exhausted.has(entry.label)) continue
      tried.push(entry.label)
      try {
        return await entry.client.completeStructured({ ...params, model: entry.model })
      } catch (err) {
        if (isRateLimitError(err)) {
          this.exhausted.add(entry.label)
          continue
        }
        throw err
      }
    }

    throw new AllProvidersExhaustedError(tried.length > 0 ? tried : ['(none available)'])
  }

  /** For tests and diagnostics — which providers this instance has given up on. */
  get exhaustedProviders(): string[] {
    return [...this.exhausted]
  }
}
