import OpenAI from 'openai'

import type {
  AssistantTurn,
  CopilotMessage,
  LlmClient,
  StructuredCompletionParams,
  ToolCall,
  ToolCallingLlmClient,
  ToolCompletionParams,
} from './client'

/** Our message shape -> the OpenAI wire shape. */
function toWireMessages(
  messages: CopilotMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' }
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: m.content,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((t) => ({
                id: t.id,
                type: 'function' as const,
                function: { name: t.name, arguments: t.arguments },
              })),
            }
          : {}),
      }
    }
    return { role: m.role, content: m.content }
  })
}

/**
 * The real implementation. Constructed lazily (see getOpenRouterClient) so
 * importing this module never requires OPENROUTER_API_KEY to be set — the same
 * lazy pattern as src/db/client.ts, and for the same reason: a build or a test
 * file that merely imports this module must not fail for lack of a key it
 * never uses.
 */
class OpenRouterClient implements LlmClient, ToolCallingLlmClient {
  private readonly client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        // Optional attribution OpenRouter shows on its dashboard.
        'HTTP-Referer': process.env.OPENROUTER_SITE_URL ?? 'http://localhost:3000',
        'X-Title': process.env.OPENROUTER_APP_NAME ?? 'Sightline',
      },
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
        `OpenRouter returned no content for model ${params.model} ` +
          `(finish_reason: ${response.choices[0]?.finish_reason ?? 'unknown'})`,
      )
    }

    try {
      return JSON.parse(content)
    } catch {
      /*
       * Verified against live OpenRouter (2026-08-06): despite requesting
       * response_format: json_schema with strict:true, at least one free
       * model (openai/gpt-oss-20b:free) returned pure markdown prose instead
       * of JSON — advertised structured-output support does not reliably
       * hold in practice. As a defensive fallback, look for the outermost
       * {...} object in the response and try that; models that wrap valid
       * JSON in commentary are recoverable this way even though a model that
       * ignores the schema entirely (as observed) still is not.
       */
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
        `OpenRouter returned non-JSON content for model ${params.model}: ${content.slice(0, 200)}`,
      )
    }
  }

  /**
   * Streams one assistant turn, accumulating any tool calls as it goes.
   *
   * Tool calls arrive across chunks the same way content does — a chunk may
   * carry the id and function name, and later chunks only argument fragments,
   * keyed by `index`. So they are assembled positionally rather than by id;
   * assuming the id is present on every fragment produces empty tool names
   * intermittently, which looks like a model fault and is not one.
   */
  async streamWithTools(
    params: ToolCompletionParams,
    onDelta: (text: string) => void,
  ): Promise<AssistantTurn> {
    const stream = await this.client.chat.completions.create({
      model: params.model,
      messages: toWireMessages(params.messages),
      tools: params.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })),
      tool_choice: params.toolChoice ?? 'auto',
      max_tokens: params.maxTokens ?? 1500,
      temperature: params.temperature ?? 0.2,
      stream: true,
    })

    let content = ''
    const partial: Array<{ id: string; name: string; arguments: string }> = []

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        content += delta.content
        onDelta(delta.content)
      }

      for (const call of delta.tool_calls ?? []) {
        const slot = (partial[call.index] ??= { id: '', name: '', arguments: '' })
        if (call.id) slot.id = call.id
        if (call.function?.name) slot.name += call.function.name
        if (call.function?.arguments) slot.arguments += call.function.arguments
      }
    }

    const toolCalls: ToolCall[] = partial
      .filter((c) => c && c.name)
      .map((c, i) => ({
        id: c.id || `call_${i}`,
        name: c.name,
        arguments: c.arguments || '{}',
      }))

    return { content, toolCalls }
  }
}

let instance: OpenRouterClient | null = null

export function getOpenRouterClient(): LlmClient & ToolCallingLlmClient {
  if (!instance) {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) {
      throw new Error(
        'OPENROUTER_API_KEY is not set. Copy .env.example to .env.local and fill it in.',
      )
    }
    instance = new OpenRouterClient(apiKey)
  }
  return instance
}
