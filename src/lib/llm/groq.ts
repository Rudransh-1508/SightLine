import OpenAI from 'openai'

import type { LlmClient, StructuredCompletionParams } from './client'

/**
 * Groq's chat completions API is OpenAI-compatible at
 * https://api.groq.com/openai/v1 — verified live (design spec
 * 2026-08-06-groq-provider-fallback-design.md §3.2), including
 * response_format: json_schema with strict:true.
 *
 * Structurally identical to OpenRouterClient on purpose: lazy construction so
 * importing this module never requires GROQ_API_KEY to be set, and the same
 * defensive brace-extraction fallback for a model that ignores the schema and
 * returns prose — a real failure mode proved live against a different
 * provider in Phase 5, not a hypothetical worth skipping here.
 *
 * KNOWN FAILURE MODE — token exhaustion masquerading as a schema error.
 * When Groq's constrained decoder runs out of max_tokens mid-generation it
 * does NOT return a truncated response with finish_reason "length" (which is
 * what OpenRouter does). It returns HTTP 400 with
 * "Failed to validate JSON. Please adjust your prompt." That message points
 * at the schema, but the schema is usually fine — the budget is not.
 * Verified live: the same article and schema 400s at max_tokens 800 and
 * succeeds at 2500, having spent 1,314 reasoning tokens. If you see that 400,
 * raise max_tokens before touching the schema.
 */
class GroqClient implements LlmClient {
  private readonly client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://api.groq.com/openai/v1',
    })
  }

  async completeStructured(params: StructuredCompletionParams): Promise<unknown> {
    const response = await this.client.chat.completions.create({
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens ?? 1024,
      temperature: params.temperature ?? 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: params.schemaName,
          strict: true,
          schema: params.schema,
        },
      },
    })

    const content = response.choices[0]?.message?.content
    if (!content) {
      throw new Error(
        `Groq returned no content for model ${params.model} ` +
          `(finish_reason: ${response.choices[0]?.finish_reason ?? 'unknown'})`,
      )
    }

    try {
      return JSON.parse(content)
    } catch {
      const start = content.indexOf('{')
      const end = content.lastIndexOf('}')
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(content.slice(start, end + 1))
        } catch {
          // fall through to the error below
        }
      }
      throw new Error(
        `Groq returned non-JSON content for model ${params.model}: ${content.slice(0, 200)}`,
      )
    }
  }
}

let instance: GroqClient | null = null

export function getGroqClient(): LlmClient {
  if (!instance) {
    const apiKey = process.env.GROQ_API_KEY
    if (!apiKey) {
      throw new Error(
        'GROQ_API_KEY is not set. Copy .env.example to .env.local and fill it in.',
      )
    }
    instance = new GroqClient(apiKey)
  }
  return instance
}
