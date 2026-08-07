import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The HTTP contract for the copilot: auth, validation, metering order and the
 * shape of the NDJSON stream. The agent, the context loader and the provider
 * are all mocked — what matters here is that a caller who cannot pay never
 * reaches a model, and that a failed run is refunded rather than billed.
 */

const requireUser = vi.hoisted(() => vi.fn())
const buildCopilotContext = vi.hoisted(() => vi.fn())
const runCopilot = vi.hoisted(() => vi.fn())
const createToolRunner = vi.hoisted(() => vi.fn())
const getOpenRouterClient = vi.hoisted(() => vi.fn())
const reserve = vi.hoisted(() => vi.fn())
const settle = vi.hoisted(() => vi.fn())
const refund = vi.hoisted(() => vi.fn())
const getBalance = vi.hoisted(() => vi.fn())

class InsufficientCreditsError extends Error {
  readonly status = 402
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`Insufficient credits: need ${required}, have ${available}`)
  }
}

vi.mock('@/lib/auth', () => ({ requireUser }))
vi.mock('@/lib/copilot/context', () => ({ buildCopilotContext }))
vi.mock('@/lib/copilot/agent', () => ({ runCopilot }))
vi.mock('@/lib/copilot/tools', () => ({ createToolRunner }))
vi.mock('@/lib/llm/openrouter', () => ({ getOpenRouterClient }))
vi.mock('@/lib/credits', () => ({
  CREDIT_COSTS: { copilot_simple: 3, copilot_complex: 5 },
  InsufficientCreditsError,
  reserve,
  settle,
  refund,
  getBalance,
}))

const RESERVATION = { id: 'led_1', feature: 'copilot_complex', cost: 5, userId: 'u1' }

beforeEach(() => {
  vi.clearAllMocks()
  process.env.OPENROUTER_COPILOT_MODEL = 'test/copilot'
  requireUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' })
  buildCopilotContext.mockResolvedValue({
    datasetName: 'Repsol',
    context: {},
    client: { id: 'repsol', name: 'Repsol' },
  })
  createToolRunner.mockReturnValue({ definitions: [] })
  getOpenRouterClient.mockReturnValue({ streamWithTools: vi.fn() })
  reserve.mockResolvedValue(RESERVATION)
  settle.mockResolvedValue(2)
  refund.mockResolvedValue(undefined)
  getBalance.mockResolvedValue(95)
  runCopilot.mockImplementation(async ({ onEvent }) => {
    onEvent({ type: 'delta', text: 'Because [node:repsol].' })
    onEvent({ type: 'citations', nodes: ['repsol'], edges: [], unverified: [] })
    return {
      answer: 'Because [node:repsol].',
      toolCallCount: 1,
      citations: { nodes: ['repsol'], edges: [] },
      unverified: [],
    }
  })
})

function post(body: unknown) {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function route() {
  return import('../route')
}

/** Collects an NDJSON body into the events it carried. */
async function events(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('POST /api/chat — auth', () => {
  it('returns 401 without a session and never reserves credits', async () => {
    requireUser.mockRejectedValueOnce(new Error('No session'))
    const { POST } = await route()

    const res = await POST(post({ question: 'why?' }))

    expect(res.status).toBe(401)
    expect(reserve).not.toHaveBeenCalled()
    expect(runCopilot).not.toHaveBeenCalled()
  })
})

describe('POST /api/chat — validation', () => {
  it('rejects a malformed body with 400', async () => {
    const { POST } = await route()
    expect((await POST(post('not json'))).status).toBe(400)
  })

  it('rejects a missing or blank question with 400', async () => {
    const { POST } = await route()
    expect((await POST(post({}))).status).toBe(400)
    expect((await POST(post({ question: '   ' }))).status).toBe(400)
    expect(reserve).not.toHaveBeenCalled()
  })

  it('rejects an over-long question with 400', async () => {
    const { POST } = await route()
    const res = await POST(post({ question: 'x'.repeat(2001) }))
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown dataset', async () => {
    buildCopilotContext.mockResolvedValueOnce(null)
    const { POST } = await route()

    const res = await POST(post({ question: 'why?', dataset: 'nope' }))

    expect(res.status).toBe(404)
    expect(reserve).not.toHaveBeenCalled()
  })

  it('returns 503 when the copilot model is not configured', async () => {
    delete process.env.OPENROUTER_COPILOT_MODEL
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { POST } = await route()

    const res = await POST(post({ question: 'why?' }))

    expect(res.status).toBe(503)
    expect(reserve).not.toHaveBeenCalled()
  })
})

describe('POST /api/chat — metering', () => {
  /**
   * The rule from CLAUDE.md: the balance is checked BEFORE the provider is
   * contacted. If this regresses, the 402 arrives after the tokens were spent.
   */
  it('returns 402 without running the copilot when credits are short', async () => {
    reserve.mockRejectedValueOnce(new InsufficientCreditsError(5, 1))
    const { POST } = await route()

    const res = await POST(post({ question: 'why?' }))

    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ required: 5, available: 1 })
    expect(runCopilot).not.toHaveBeenCalled()
  })

  /**
   * The price is only known once the model stops calling tools, so the worst
   * case is reserved up front. Reserving the cheaper price would let a caller
   * with 3 credits start a 5-credit question.
   */
  it('reserves at the complex rate before any model call', async () => {
    const { POST } = await route()
    await POST(post({ question: 'why?' }))
    expect(reserve).toHaveBeenCalledWith('u1', 'copilot_complex', undefined)
  })

  it('settles down to the simple rate for a question of two tool calls or fewer', async () => {
    const { POST } = await route()
    const res = await POST(post({ question: 'why?' }))
    const done = (await events(res)).find((e) => e.type === 'done')

    expect(settle).toHaveBeenCalledWith(RESERVATION, 'copilot_simple')
    expect(done).toMatchObject({ toolCalls: 1, creditsCharged: 3, balance: 95 })
  })

  it('charges the complex rate past two tool calls', async () => {
    runCopilot.mockResolvedValueOnce({
      answer: 'a',
      toolCallCount: 3,
      citations: { nodes: [], edges: [] },
      unverified: [],
    })
    const { POST } = await route()

    const res = await POST(post({ question: 'how does OFAC reach Repsol?' }))
    const done = (await events(res)).find((e) => e.type === 'done')

    expect(settle).toHaveBeenCalledWith(RESERVATION, 'copilot_complex')
    expect(done).toMatchObject({ creditsCharged: 5 })
  })

  it('refunds and reports an error when the run fails mid-stream', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    runCopilot.mockRejectedValueOnce(new Error('provider exploded'))
    const { POST } = await route()

    const res = await POST(post({ question: 'why?' }))
    const emitted = await events(res)

    expect(refund).toHaveBeenCalledWith(RESERVATION, expect.stringContaining('refund'))
    expect(settle).not.toHaveBeenCalled()
    expect(emitted.at(-1)).toMatchObject({ type: 'error' })
    expect(JSON.stringify(emitted)).not.toContain('provider exploded')
  })
})

describe('POST /api/chat — the stream', () => {
  it('streams NDJSON with the agent events and a done event', async () => {
    const { POST } = await route()
    const res = await POST(post({ question: 'why?' }))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/x-ndjson')
    expect(res.headers.get('Cache-Control')).toBe('no-store')

    const emitted = await events(res)
    expect(emitted.map((e) => e.type)).toEqual(['delta', 'citations', 'done'])
    expect(emitted[0]).toMatchObject({ text: 'Because [node:repsol].' })
  })

  /**
   * Without this, "what is my Algeria exposure" gets refused for not knowing
   * what "my" means — the client identity has to reach the agent, not just
   * live in buildCopilotContext's return value.
   */
  it('passes the dataset\'s client identity to the agent so "me" resolves', async () => {
    const { POST } = await route()
    await POST(post({ question: 'why?' }))
    expect(runCopilot).toHaveBeenCalledWith(
      expect.objectContaining({ graphClient: { id: 'repsol', name: 'Repsol' } }),
    )
  })

  it('defaults to the demo dataset and passes an explicit one through', async () => {
    const { POST } = await route()

    await POST(post({ question: 'why?' }))
    expect(buildCopilotContext).toHaveBeenCalledWith('repsol-demo')

    await POST(post({ question: 'why?', dataset: 'live' }))
    expect(buildCopilotContext).toHaveBeenLastCalledWith('live')
  })
})
