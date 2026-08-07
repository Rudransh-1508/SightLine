import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The one piece of real logic in the OpenRouter client: reassembling a
 * streamed assistant turn. The `openai` SDK is mocked, so no network and no
 * key — this is about the wire format, which is fiddly enough to be worth
 * pinning down.
 */

const create = vi.hoisted(() => vi.fn())

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } }
  },
}))

function stream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  }
}

const delta = (d: unknown) => ({ choices: [{ delta: d }] })

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  process.env.OPENROUTER_API_KEY = 'test-key'
})

async function client() {
  const { getOpenRouterClient } = await import('../openrouter')
  return getOpenRouterClient()
}

const params = {
  model: 'test/copilot',
  messages: [{ role: 'user' as const, content: 'why?' }],
  tools: [{ name: 'get_node', description: 'd', parameters: { type: 'object' } }],
}

describe('streamWithTools', () => {
  it('streams content deltas as they arrive and returns the whole turn', async () => {
    create.mockResolvedValue(
      stream([delta({ content: 'Repsol ' }), delta({ content: 'is the client.' })]),
    )
    const seen: string[] = []

    const turn = await (await client()).streamWithTools(params, (t) => seen.push(t))

    expect(seen).toEqual(['Repsol ', 'is the client.'])
    expect(turn).toEqual({ content: 'Repsol is the client.', toolCalls: [] })
  })

  /**
   * Tool calls arrive across chunks keyed by `index` — the id and name land on
   * the first fragment and the arguments dribble in afterwards. Keying by id
   * instead would intermittently produce nameless tool calls.
   */
  it('reassembles a tool call split across chunks', async () => {
    create.mockResolvedValue(
      stream([
        delta({
          tool_calls: [
            { index: 0, id: 'call_1', function: { name: 'get_node', arguments: '' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"node_' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'id":"repsol"}' } }] }),
      ]),
    )

    const turn = await (await client()).streamWithTools(params, () => {})

    expect(turn.toolCalls).toEqual([
      { id: 'call_1', name: 'get_node', arguments: '{"node_id":"repsol"}' },
    ])
  })

  it('keeps parallel tool calls apart by index', async () => {
    create.mockResolvedValue(
      stream([
        delta({
          tool_calls: [
            { index: 0, id: 'a', function: { name: 'get_node', arguments: '{"node_id":' } },
            { index: 1, id: 'b', function: { name: 'get_metrics', arguments: '{}' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"repsol"}' } }] }),
      ]),
    )

    const turn = await (await client()).streamWithTools(params, () => {})

    expect(turn.toolCalls).toEqual([
      { id: 'a', name: 'get_node', arguments: '{"node_id":"repsol"}' },
      { id: 'b', name: 'get_metrics', arguments: '{}' },
    ])
  })

  it('carries prose and tool calls from the same turn', async () => {
    create.mockResolvedValue(
      stream([
        delta({ content: 'Let me look.' }),
        delta({ tool_calls: [{ index: 0, id: 'a', function: { name: 'get_metrics' } }] }),
      ]),
    )

    const turn = await (await client()).streamWithTools(params, () => {})

    expect(turn.content).toBe('Let me look.')
    expect(turn.toolCalls).toHaveLength(1)
    // No arguments streamed at all still has to be valid JSON for the runner.
    expect(turn.toolCalls[0].arguments).toBe('{}')
  })

  it('sends the tool definitions and honours tool_choice none', async () => {
    create.mockResolvedValue(stream([delta({ content: 'answer' })]))

    await (await client()).streamWithTools({ ...params, toolChoice: 'none' }, () => {})

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: true,
        tool_choice: 'none',
        tools: [
          {
            type: 'function',
            function: { name: 'get_node', description: 'd', parameters: { type: 'object' } },
          },
        ],
      }),
    )
  })

  it('translates assistant tool calls and tool results to the wire shape', async () => {
    create.mockResolvedValue(stream([delta({ content: 'ok' })]))

    await (
      await client()
    ).streamWithTools(
      {
        ...params,
        messages: [
          { role: 'user', content: 'why?' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'get_node', arguments: '{}' }],
          },
          { role: 'tool', toolCallId: 'c1', content: '{"node_id":"repsol"}' },
        ],
      },
      () => {},
    )

    const sent = create.mock.calls[0][0].messages
    expect(sent[1]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_node' } }],
    })
    expect(sent[2]).toEqual({
      role: 'tool',
      content: '{"node_id":"repsol"}',
      tool_call_id: 'c1',
    })
  })
})
