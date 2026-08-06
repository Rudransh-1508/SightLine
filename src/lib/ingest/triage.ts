import type { LlmClient } from '@/lib/llm/client'
import { triageResponseSchema, triageJsonSchema } from './schemas'

export interface TriageInput {
  title: string
  body: string
  matchedNodeIds: string[]
}

export interface TriageResult<T> {
  doc: T
  relevant: boolean
}

const TRIAGE_SYSTEM_PROMPT = `You triage news documents for a geopolitical risk graph tracking
relationships between organisations and people. For each document, decide whether it is
substantively ABOUT a relationship or status change involving the named entities — not merely a
document that happens to mention them. A profile piece, a passing reference in an unrelated
story, or a routine market report should be marked NOT relevant. A document reporting a new
contract, a dispute, a policy shift affecting the relationship, or a change in how two parties
are dealing with each other should be marked relevant.`

function excerpt(body: string, maxChars = 300): string {
  return body.length > maxChars ? body.slice(0, maxChars) + '…' : body
}

/**
 * One LLM call classifies the whole batch — this is what keeps the pipeline
 * inside the free tier's 50-requests/day cap (design spec §3.4.1). Documents
 * are indexed by position rather than id so the prompt stays short; the
 * response is matched back to the input array by that index.
 */
export async function triageBatch<T extends TriageInput>(
  client: LlmClient,
  model: string,
  docs: T[],
): Promise<Array<TriageResult<T>>> {
  if (docs.length === 0) return []

  const listing = docs
    .map(
      (d, i) =>
        `[${i}] "${d.title}"\nMentions: ${d.matchedNodeIds.join(', ') || '(none)'}\n` +
        `Excerpt: ${excerpt(d.body)}`,
    )
    .join('\n\n')

  const raw = await client.completeStructured({
    model,
    schemaName: 'triage_batch',
    schema: triageJsonSchema,
    /*
     * Reasoning-capable models spend completion tokens on an invisible
     * reasoning trace before the JSON. Running out mid-reasoning yields an
     * EMPTY content field, not a truncated answer, so this needs real
     * headroom rather than a tight estimate. Measured live on a trivial
     * two-document classification:
     *   nemotron-nano-9b-v2:free  373 reasoning tokens (33 visible)
     *   groq openai/gpt-oss-20b   641 reasoning tokens (36 visible)
     * Reasoning cost is driven far more by the number of items to weigh up
     * than by their length, so the per-document term dominates the base.
     */
    maxTokens: 2000 + docs.length * 150,
    messages: [
      { role: 'system', content: TRIAGE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Classify each of these ${docs.length} documents:\n\n${listing}`,
      },
    ],
  })

  const parsed = triageResponseSchema.safeParse(raw)
  if (!parsed.success) {
    // Malformed output is a logged failure, not a crash — the whole batch's
    // spend was already incurred, so degrading to "review everything" is
    // safer than silently dropping documents that might matter.
    console.error('triageBatch: response failed schema validation', parsed.error.issues)
    return docs.map((doc) => ({ doc, relevant: true }))
  }

  const byIndex = new Map(parsed.data.results.map((r) => [r.index, r.relevant]))
  return docs.map((doc, i) => ({
    doc,
    // A document the model never returned a verdict for is treated as
    // relevant rather than silently discarded — the same fail-open reasoning
    // as a malformed response.
    relevant: byIndex.get(i) ?? true,
  }))
}
