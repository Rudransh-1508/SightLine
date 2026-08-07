import type {
  AssistantTurn,
  LlmClient,
  StructuredCompletionParams,
  ToolCallingLlmClient,
  ToolCompletionParams,
} from './client'

/**
 * Test double. Every ingestion and copilot test constructs one of these
 * instead of touching the network — see CLAUDE.md: the suite must never cost
 * money, and a real call would also make tests flaky and slow.
 *
 * Responses are queued in call order, which mirrors how the pipeline actually
 * behaves: one call for the batched triage, then one call per surviving
 * document for extraction.
 */
export class MockLlmClient implements LlmClient {
  private queue: Array<unknown | Error> = []
  readonly calls: StructuredCompletionParams[] = []

  /** Queues the next response, in the order completeStructured will be called. */
  respondWith(response: unknown): this {
    this.queue.push(response)
    return this
  }

  /** Queues a failure for the next call, simulating a provider error. */
  failWith(error: Error): this {
    this.queue.push(error)
    return this
  }

  async completeStructured(params: StructuredCompletionParams): Promise<unknown> {
    this.calls.push(params)
    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error(
        `MockLlmClient.completeStructured called with no queued response ` +
          `(call #${this.calls.length}, schema "${params.schemaName}"). ` +
          `Call .respondWith() or .failWith() before running the code under test.`,
      )
    }
    if (next instanceof Error) throw next
    return next
  }

  /** Number of calls made — the thing most ingestion tests actually assert on. */
  get callCount(): number {
    return this.calls.length
  }
}

/**
 * Test double for the copilot's tool-calling client.
 *
 * Turns are queued in order, mirroring the agent loop: a turn asking for tools,
 * then another, then a turn with prose and no tool calls, which ends the loop.
 * Content is delivered to `onDelta` in small slices so tests exercise the same
 * streaming path the route uses rather than a single-shot shortcut.
 */
export class MockToolCallingClient implements ToolCallingLlmClient {
  private queue: Array<AssistantTurn | Error> = []
  readonly calls: ToolCompletionParams[] = []

  respondWith(turn: Partial<AssistantTurn>): this {
    this.queue.push({ content: turn.content ?? '', toolCalls: turn.toolCalls ?? [] })
    return this
  }

  failWith(error: Error): this {
    this.queue.push(error)
    return this
  }

  async streamWithTools(
    params: ToolCompletionParams,
    onDelta: (text: string) => void,
  ): Promise<AssistantTurn> {
    this.calls.push(params)
    const next = this.queue.shift()
    if (next === undefined) {
      throw new Error(
        `MockToolCallingClient.streamWithTools called with no queued turn ` +
          `(call #${this.calls.length}). Queue one with .respondWith() first.`,
      )
    }
    if (next instanceof Error) throw next

    for (let i = 0; i < next.content.length; i += 8) {
      onDelta(next.content.slice(i, i + 8))
    }
    return next
  }

  get callCount(): number {
    return this.calls.length
  }
}
