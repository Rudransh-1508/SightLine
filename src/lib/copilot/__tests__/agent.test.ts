import { describe, it, expect } from 'vitest'

import { runCopilot, EmptyAnswerError, type CopilotEvent } from '../agent'
import { contextFromGraph, createToolRunner } from '../tools'
import { MockToolCallingClient } from '@/lib/llm/mock'
import type { GraphData } from '@/lib/types'

/**
 * The agent loop, with the provider replaced by a queue of scripted turns —
 * no network, per CLAUDE.md. What is under test is the loop's behaviour: that
 * tool results get fed back, that it terminates, and above all that citations
 * are verified against what the tools actually returned.
 */

const GRAPH: GraphData = {
  client: 'repsol',
  asOf: '2026-08-06',
  nodes: [
    {
      id: 'repsol',
      name: 'Repsol',
      category: 'client',
      country: 'ES',
      region: 'Iberia',
      influence: 100,
      role: 'the client',
      description: 'd',
    },
    {
      id: 'sonatrach',
      name: 'Sonatrach',
      category: 'supplier',
      country: 'DZ',
      region: 'North Africa',
      influence: 80,
      role: 'gas supplier',
      description: 'd',
    },
  ],
  edges: [
    {
      source: 'repsol',
      target: 'sonatrach',
      type: 'contractual',
      direction: 'source-depends',
      strength: 85,
      state: 'strained',
      trajectory: 'improving',
      exposure: 'gas supply',
      since: 2010,
      lastEvent: { date: '2026-01', summary: 'price review' },
      narrative: 'n',
      confidence: 'high',
    },
  ],
}

function setup() {
  const client = new MockToolCallingClient()
  const runner = createToolRunner(contextFromGraph(GRAPH))
  const events: CopilotEvent[] = []
  const run = (
    question = 'What is my Algeria exposure?',
    maxRounds?: number,
    maxToolCalls?: number,
  ) =>
    runCopilot({
      client,
      model: 'test-copilot',
      question,
      runner,
      graphClient: { id: 'repsol', name: 'Repsol' },
      maxRounds,
      maxToolCalls,
      onEvent: (e) => events.push(e),
    })
  return { client, runner, events, run }
}

const toolCall = (name: string, args: object, id = 'call_1') => ({
  id,
  name,
  arguments: JSON.stringify(args),
})

describe('client grounding', () => {
  /**
   * The failure this pins: the first live question ("What is my Algeria
   * exposure?") was refused because the model had no way to know what "my"
   * meant. The system prompt now names the graph's client explicitly, so
   * "me"/"my"/"us" never needs a tool call to resolve.
   */
  it('tells the model who "me" refers to, by name and id', async () => {
    const { client, run } = setup()
    client.respondWith({ content: 'Answer.' })

    await run('What is my Algeria exposure?')

    const system = client.calls[0].messages[0]
    expect(system.role).toBe('system')
    expect(system.content).toContain('"me", "my", "us"')
    expect(system.content).toContain('they mean Repsol')
    expect(system.content).toContain('node id "repsol"')
  })
})

describe('the tool loop', () => {
  it('feeds tool results back and answers on the next turn', async () => {
    const { client, run } = setup()
    client
      .respondWith({ toolCalls: [toolCall('get_relationships', { node_id: 'repsol' })] })
      .respondWith({ content: 'Gas supply via [edge:repsol->sonatrach:contractual].' })

    const result = await run()

    expect(result.toolCallCount).toBe(1)
    expect(result.answer).toContain('Gas supply')

    // The second call must carry the tool result, or the model answered blind.
    const second = client.calls[1]
    expect(second.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(second.messages[3].content).toContain('repsol->sonatrach:contractual')
    expect(second.messages[3].toolCallId).toBe('call_1')
  })

  it('runs several tool calls in one turn', async () => {
    const { client, run } = setup()
    client
      .respondWith({
        toolCalls: [
          toolCall('get_node', { node_id: 'repsol' }, 'c1'),
          toolCall('get_node', { node_id: 'sonatrach' }, 'c2'),
        ],
      })
      .respondWith({ content: 'Both exist [node:repsol] [node:sonatrach].' })

    const result = await run()
    expect(result.toolCallCount).toBe(2)
    expect(client.calls[1].messages.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  /**
   * A model that keeps calling tools must still terminate with an answer
   * rather than looping until the request times out. The last round disables
   * tools, which forces prose.
   */
  it('stops at maxRounds and forces a tool-free final turn', async () => {
    const { client, run } = setup()
    client
      .respondWith({ toolCalls: [toolCall('get_node', { node_id: 'repsol' })] })
      .respondWith({ toolCalls: [toolCall('get_node', { node_id: 'repsol' })] })
      .respondWith({ content: 'Forced answer about [node:repsol].' })

    const result = await run('why', 3)

    expect(client.callCount).toBe(3)
    expect(client.calls[2].toolChoice).toBe('none')
    expect(result.answer).toBe('Forced answer about [node:repsol].')
  })

  /**
   * The round cap alone does not bound the work: one turn can request several
   * tools at once, and every result is then resent with every later turn. This
   * is the ceiling on total queries, and it must hold even with rounds to
   * spare.
   */
  it('stops calling tools once the tool-call ceiling is reached', async () => {
    const { client, run } = setup()
    client
      .respondWith({
        toolCalls: [
          toolCall('get_node', { node_id: 'repsol' }, 'c1'),
          toolCall('get_node', { node_id: 'sonatrach' }, 'c2'),
        ],
      })
      .respondWith({ content: 'Answer from what I have [node:repsol].' })

    const result = await run('why', 6, 2)

    expect(result.toolCallCount).toBe(2)
    // Rounds remained, but tools were switched off for the answering turn.
    expect(client.callCount).toBe(2)
    expect(client.calls[1].toolChoice).toBe('none')
  })

  it('surfaces an empty answer as an error rather than a blank success', async () => {
    const { client, run } = setup()
    client.respondWith({ content: '   ' })
    await expect(run()).rejects.toBeInstanceOf(EmptyAnswerError)
  })

  it('lets a tool-argument mistake be corrected instead of failing the run', async () => {
    const { client, run } = setup()
    client
      .respondWith({ toolCalls: [toolCall('get_node', { node_id: 'Sonatrach SPA' })] })
      .respondWith({ toolCalls: [toolCall('get_node', { node_id: 'sonatrach' }, 'call_2')] })
      .respondWith({ content: 'It is [node:sonatrach].' })

    const result = await run()

    expect(result.answer).toContain('sonatrach')
    expect(JSON.stringify(client.calls[1].messages)).toMatch(/No node with id/)
  })
})

describe('streaming events', () => {
  it('emits deltas, tool events and citations in order', async () => {
    const { client, run, events } = setup()
    client
      .respondWith({ toolCalls: [toolCall('get_relationships', { node_id: 'repsol' })] })
      .respondWith({ content: 'Strained but improving [edge:repsol->sonatrach:contractual].' })

    await run()

    const kinds = events.map((e) => e.type)
    expect(kinds.indexOf('tool_call')).toBeLessThan(kinds.indexOf('tool_result'))
    expect(kinds.indexOf('tool_result')).toBeLessThan(kinds.indexOf('delta'))
    expect(kinds.at(-1)).toBe('citations')
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('Strained but improving [edge:repsol->sonatrach:contractual].')
  })

  /**
   * A model that narrates before calling a tool has streamed text that is not
   * part of the answer. The consumer is told to discard it, rather than
   * showing "Let me check the graph..." above the real answer.
   */
  it('tells the consumer to discard prose that preceded a tool call', async () => {
    const { client, run, events } = setup()
    client
      .respondWith({
        content: 'Let me check the graph.',
        toolCalls: [toolCall('get_node', { node_id: 'repsol' })],
      })
      .respondWith({ content: 'Repsol [node:repsol] is the client.' })

    const result = await run()

    expect(events.some((e) => e.type === 'reset')).toBe(true)
    expect(result.answer).not.toContain('Let me check')
  })
})

describe('citation grounding', () => {
  it('returns citations for ids the tools actually returned', async () => {
    const { client, run } = setup()
    client
      .respondWith({ toolCalls: [toolCall('get_relationships', { node_id: 'repsol' })] })
      .respondWith({
        content: 'Repsol [node:repsol] depends on [edge:repsol->sonatrach:contractual].',
      })

    const result = await run()

    expect(result.citations).toEqual({
      nodes: ['repsol'],
      edges: ['repsol->sonatrach:contractual'],
    })
    expect(result.unverified).toEqual([])
  })

  /**
   * The failure mode that would discredit the whole tool: a confident claim
   * citing something that does not exist. It must never be handed back as a
   * real citation — Phase 8 will render these as clickable graph focus.
   */
  it('strips a citation naming an id no tool returned', async () => {
    const { client, run } = setup()
    client
      .respondWith({ toolCalls: [toolCall('get_node', { node_id: 'repsol' })] })
      .respondWith({
        content:
          'Exposure runs through Gazprom [node:gazprom] via [edge:repsol->gazprom:equity].',
      })

    const result = await run()

    expect(result.citations).toEqual({ nodes: [], edges: [] })
    expect(result.unverified).toEqual(['node:gazprom', 'edge:repsol->gazprom:equity'])
  })

  it('does not ground an id merely because it appears in the question', async () => {
    const { client, run } = setup()
    client.respondWith({ content: 'I could not check [node:sonatrach].' })

    const result = await run('Tell me about [node:sonatrach]')

    expect(result.citations.nodes).toEqual([])
    expect(result.unverified).toEqual(['node:sonatrach'])
  })

  it('reports each invented id once even when cited repeatedly', async () => {
    const { client, run } = setup()
    client.respondWith({ content: '[node:ghost] and again [node:ghost].' })
    const result = await run()
    expect(result.unverified).toEqual(['node:ghost'])
  })
})
