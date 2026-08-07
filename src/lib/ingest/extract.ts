import type { LlmClient } from '@/lib/llm/client'
import {
  extractionResponseSchema,
  extractionJsonSchema,
  type ExtractionResponse,
} from './schemas'

const EXTRACTION_SYSTEM_PROMPT = `You extract structured relationship data from news articles for a
geopolitical risk graph. Read the document and identify AT MOST ONE relationship or status change
between two named organisations or people.

Rules:
- sourceEntity and targetEntity must be two DIFFERENT entities. Never combine two names into one field.
- If the document does not describe a specific, attributable relationship change, set found=false
  and leave every other field null. Do not force an extraction from a document that merely mentions
  an entity in passing.
- evidenceQuote must be copied EXACTLY from the document text — the same characters, the same order.
  Do not paraphrase or summarise it. It will be checked against the source verbatim.
- state describes the relationship as of THIS document; trajectory describes its direction of travel
  as described or implied in the document, not as of some other point in time.
- strength is your estimate of how material the relationship is to sourceEntity, 0-100, based on
  what the document itself conveys (e.g. sole supplier vs one of many).`

export async function extractFromDocument(
  client: LlmClient,
  model: string,
  doc: { title: string; body: string },
): Promise<ExtractionResponse> {
  const raw = await client.completeStructured({
    model,
    schemaName: 'relationship_extraction',
    schema: extractionJsonSchema,
    /*
     * Reasoning headroom, verified live against Groq's openai/gpt-oss-20b on a
     * real ~1,000-token Guardian article: it spent 1,314 reasoning tokens
     * before emitting the visible JSON. The previous 800 budget failed on that
     * same article — and the failure mode is genuinely misleading: Groq's
     * constrained decoder does NOT return a truncated response with
     * finish_reason "length" (as OpenRouter did). It returns HTTP 400
     * "Failed to validate JSON. Please adjust your prompt.", which reads like
     * a schema bug but is actually token exhaustion. Confirmed by running the
     * identical schema and article at 800 (400 error) vs 2500 (clean success).
     * Do not lower this without re-testing on a long article.
     */
    maxTokens: 3000,
    temperature: 0.1,
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Title: ${doc.title}\n\nBody:\n${doc.body}`,
      },
    ],
  })

  const parsed = extractionResponseSchema.safeParse(raw)
  if (!parsed.success) {
    // A malformed extraction is discarded, not guessed at — unlike triage,
    // where fail-open just means "review this too", fabricating relationship
    // data from an invalid response is the failure mode the evidence check
    // exists to prevent, and half of that protection is never trusting output
    // that didn't even pass its own schema.
    throw new ExtractionValidationError(parsed.error.issues)
  }
  return parsed.data
}

export class ExtractionValidationError extends Error {
  constructor(readonly issues: unknown) {
    super('Extraction response failed schema validation')
    this.name = 'ExtractionValidationError'
  }
}
