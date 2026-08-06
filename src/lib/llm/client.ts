/**
 * The seam between ingestion/copilot logic and the model provider.
 *
 * Every test in this project mocks this interface rather than reaching
 * OpenRouter — CLAUDE.md is explicit that the suite must never cost money, and
 * a network call in a test is both slow and non-deterministic. `openrouter.ts`
 * is the only file that imports the `openai` SDK or reads `OPENROUTER_API_KEY`.
 */

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface StructuredCompletionParams {
  model: string
  messages: ChatMessage[]
  /** JSON Schema, passed straight through as OpenRouter's response_format. */
  schema: Record<string, unknown>
  /** Name OpenRouter attaches to the schema; shows up in provider logs. */
  schemaName: string
  maxTokens?: number
  temperature?: number
}

/**
 * Tool-calling is a SEPARATE interface from structured output, deliberately.
 *
 * Ingestion needs strict JSON-schema output and never calls tools; the copilot
 * needs tools and streamed prose and never wants a JSON envelope. Modelling
 * them as one interface would force every provider to implement both, and
 * would make the fallback chain (which is structured-output-only, per the Groq
 * design spec) claim a capability it does not have.
 */
export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the tool's arguments object. */
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string as the model emitted it — parsing is the caller's job. */
  arguments: string
}

export type CopilotRole = 'system' | 'user' | 'assistant' | 'tool'

export interface CopilotMessage {
  role: CopilotRole
  content: string
  /** Present on an assistant turn that requested tools. */
  toolCalls?: ToolCall[]
  /** Present on a tool result, linking it back to the request. */
  toolCallId?: string
}

export interface ToolCompletionParams {
  model: string
  messages: CopilotMessage[]
  tools: ToolDefinition[]
  /** 'none' forces a prose answer — used for the final, tool-free turn. */
  toolChoice?: 'auto' | 'none'
  maxTokens?: number
  temperature?: number
}

/** What one assistant turn produced: prose, tool requests, or both. */
export interface AssistantTurn {
  content: string
  toolCalls: ToolCall[]
}

export interface ToolCallingLlmClient {
  /**
   * Runs one assistant turn, streaming prose to `onDelta` as it arrives and
   * returning the complete turn including any tool calls.
   *
   * Streaming and tool-calling are one method rather than two because a single
   * turn can produce both, and the caller cannot know which until the stream
   * ends. Splitting them would mean either guessing in advance or paying for
   * an extra round-trip per question.
   */
  streamWithTools(
    params: ToolCompletionParams,
    onDelta: (text: string) => void,
  ): Promise<AssistantTurn>
}

export interface LlmClient {
  /**
   * Requests strict JSON-schema structured output and returns the parsed,
   * still-untyped JSON. Callers validate the shape themselves (see
   * src/lib/ingest/schemas.ts) — the client's job is only the network call.
   *
   * Throws on a provider error or on a response that is not valid JSON. It
   * does NOT throw on a response that parses but doesn't match the caller's
   * expected shape — that is the caller's validation boundary, so a malformed
   * field can be logged with full context rather than surfacing as a client
   * exception attributable to nothing.
   */
  completeStructured(params: StructuredCompletionParams): Promise<unknown>
}
