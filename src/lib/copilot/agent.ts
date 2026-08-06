import type { CopilotMessage, ToolCallingLlmClient } from '@/lib/llm/client'
import type { ToolRunner } from './tools'

/**
 * The copilot loop: ask, let the model query the graph, answer with citations.
 *
 * Grounding is the point (design spec §6.1). The model may only assert what
 * tools returned, and every claim carries the id it came from — a confidently
 * wrong geopolitical assertion is the failure mode that would discredit the
 * whole tool. That rule is stated in the prompt AND checked afterwards here:
 * citations naming ids no tool ever returned are stripped from the citation
 * list and reported as unverified, so a hallucinated reference can never be
 * rendered as a real, clickable one.
 */

export const CITATION_SYNTAX = {
  node: /\[node:([^\]\s]+)\]/g,
  edge: /\[edge:([^\]\s]+)\]/g,
}

export const SYSTEM_PROMPT = `You are Sightline's analyst copilot. You answer questions about a stakeholder exposure graph: who surrounds a company, how each relationship is doing, and where it is heading.

RULES

1. Answer ONLY from what the tools return. You have no other knowledge of this graph. If the tools do not support an answer, say so plainly — do not fill the gap from general knowledge about these companies or countries.
2. Names are not ids. Call search_entities first to turn a name into a node_id, then use ids with the other tools.
3. Cite every specific claim inline, immediately after the clause it supports:
   - an actor as [node:NODE_ID]
   - a relationship as [edge:EDGE_ID], using the edge_id exactly as returned
   Never invent an id, and never cite an id you have not seen in a tool result.
4. Use find_paths for any question about how one actor reaches or affects another. Do not reason out a route yourself.
5. State and trajectory are different axes: state is how the relationship is now, trajectory is where it is heading. A relationship can be hostile but improving. Do not collapse them.
6. Be concise and concrete — a few sentences, the material point first. Quote the exposure or narrative when it carries the answer.`

export type CopilotEvent =
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; isError: boolean }
  | { type: 'delta'; text: string }
  /** Prose streamed so far was a preamble to a tool call — discard it. */
  | { type: 'reset' }
  | { type: 'citations'; nodes: string[]; edges: string[]; unverified: string[] }

export interface CopilotResult {
  answer: string
  toolCallCount: number
  citations: { nodes: string[]; edges: string[] }
  /** Cited ids no tool ever returned. Non-empty means the model made one up. */
  unverified: string[]
}

export interface RunCopilotParams {
  client: ToolCallingLlmClient
  model: string
  question: string
  runner: ToolRunner
  /**
   * Hard cap on assistant turns. The last one is forced to answer with tools
   * disabled, so a model that keeps calling tools still terminates with a real
   * answer rather than looping until the request times out.
   */
  maxRounds?: number
  onEvent?: (event: CopilotEvent) => void
}

/** Tool results are truncated before going back to the model. */
const MAX_TOOL_RESULT_CHARS = 8000

export class EmptyAnswerError extends Error {
  constructor() {
    super('The copilot produced no answer')
    this.name = 'EmptyAnswerError'
  }
}

function extractCitations(text: string, kind: 'node' | 'edge'): string[] {
  const pattern = new RegExp(CITATION_SYNTAX[kind].source, 'g')
  const found = new Set<string>()
  for (const match of text.matchAll(pattern)) found.add(match[1])
  return [...found]
}

export async function runCopilot(params: RunCopilotParams): Promise<CopilotResult> {
  const { client, model, question, runner, maxRounds = 4, onEvent = () => {} } = params

  const messages: CopilotMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ]

  let toolCallCount = 0
  let answer = ''

  for (let round = 1; round <= maxRounds; round++) {
    const isFinalRound = round === maxRounds
    let streamed = ''

    const turn = await client.streamWithTools(
      {
        model,
        messages,
        tools: runner.definitions,
        toolChoice: isFinalRound ? 'none' : 'auto',
      },
      (text) => {
        streamed += text
        onEvent({ type: 'delta', text })
      },
    )

    if (turn.toolCalls.length === 0 || isFinalRound) {
      answer = turn.content || streamed
      break
    }

    /*
     * The model spoke before deciding to call a tool. That prose is a preamble
     * to work not yet done, not part of the answer, so the consumer is told to
     * drop it. Buffering instead — holding every delta until the round ends —
     * would remove the latency benefit streaming exists for.
     */
    if (streamed.trim().length > 0) onEvent({ type: 'reset' })

    messages.push({ role: 'assistant', content: turn.content, toolCalls: turn.toolCalls })

    for (const call of turn.toolCalls) {
      toolCallCount++
      onEvent({ type: 'tool_call', name: call.name, args: call.arguments })
      const run = await runner.execute(call.name, call.arguments)
      onEvent({ type: 'tool_result', name: call.name, isError: run.isError })
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: JSON.stringify(run.result).slice(0, MAX_TOOL_RESULT_CHARS),
      })
    }
  }

  if (!answer.trim()) throw new EmptyAnswerError()

  const { nodeIds, edgeIds } = runner.grounding
  const citedNodes = extractCitations(answer, 'node')
  const citedEdges = extractCitations(answer, 'edge')

  const nodes = citedNodes.filter((id) => nodeIds.has(id))
  const edges = citedEdges.filter((id) => edgeIds.has(id))
  const unverified = [
    ...citedNodes.filter((id) => !nodeIds.has(id)).map((id) => `node:${id}`),
    ...citedEdges.filter((id) => !edgeIds.has(id)).map((id) => `edge:${id}`),
  ]

  onEvent({ type: 'citations', nodes, edges, unverified })

  return { answer, toolCallCount, citations: { nodes, edges }, unverified }
}
