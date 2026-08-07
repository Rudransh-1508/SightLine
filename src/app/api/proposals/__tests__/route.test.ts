import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Route-level tests for the review endpoint. No database and no network — the
 * review module is mocked, because what is under test here is the HTTP
 * contract: auth, status codes, and that the right function is called.
 */

const requireUser = vi.hoisted(() => vi.fn())
const approveProposal = vi.hoisted(() => vi.fn())
const rejectProposal = vi.hoisted(() => vi.fn())

class ProposalNotPendingError extends Error {
  constructor(readonly status: string) {
    super(`Proposal is already ${status}`)
    this.name = 'ProposalNotPendingError'
  }
}
class ProposalIncompleteError extends Error {
  constructor(reason: string) {
    super(`Proposal cannot be applied: ${reason}`)
    this.name = 'ProposalIncompleteError'
  }
}

vi.mock('@/lib/auth', () => ({ requireUser }))
vi.mock('@/lib/review', () => ({
  approveProposal,
  rejectProposal,
  ProposalNotPendingError,
  ProposalIncompleteError,
}))

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ id: 'u1', email: 'a@b.c' })
  approveProposal.mockResolvedValue({ edgeId: 'e1', createdNodeIds: [] })
  rejectProposal.mockResolvedValue(undefined)
})

function post(body: unknown, id = 'p1') {
  return {
    request: new Request(`http://localhost/api/proposals/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  }
}

async function route() {
  return import('../[id]/route')
}

describe('POST /api/proposals/[id] — auth', () => {
  /**
   * The security boundary is here, not in proxy.ts — Next's docs are explicit
   * that proxy must not be relied on for authorization. Deleting the proxy
   * must not make this route reachable.
   */
  it('returns 401 when there is no session', async () => {
    requireUser.mockRejectedValueOnce(new Error('No session'))
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve' })

    const res = await POST(request, ctx)

    expect(res.status).toBe(401)
    expect(approveProposal).not.toHaveBeenCalled()
  })

  it('verifies the session before doing any work', async () => {
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve' })
    await POST(request, ctx)
    expect(requireUser).toHaveBeenCalled()
  })
})

describe('POST /api/proposals/[id] — validation', () => {
  it('rejects a malformed JSON body with 400', async () => {
    const { POST } = await route()
    const { request, ctx } = post('not json at all')
    const res = await POST(request, ctx)
    expect(res.status).toBe(400)
  })

  it('rejects an unknown action with 400', async () => {
    const { POST } = await route()
    const { request, ctx } = post({ action: 'delete' })
    const res = await POST(request, ctx)

    expect(res.status).toBe(400)
    expect(approveProposal).not.toHaveBeenCalled()
    expect(rejectProposal).not.toHaveBeenCalled()
  })

  it('rejects a missing action with 400', async () => {
    const { POST } = await route()
    const { request, ctx } = post({})
    expect((await POST(request, ctx)).status).toBe(400)
  })
})

describe('POST /api/proposals/[id] — approve', () => {
  it('approves and returns the created edge id', async () => {
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve' })

    const res = await POST(request, ctx)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({ ok: true, edgeId: 'e1' })
    expect(approveProposal).toHaveBeenCalledWith('p1', { note: undefined })
  })

  it('passes a reviewer note through', async () => {
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve', note: 'looks right' })
    await POST(request, ctx)
    expect(approveProposal).toHaveBeenCalledWith('p1', { note: 'looks right' })
  })

  it('uses the id from the route params, not the body', async () => {
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve' }, 'prop_xyz')
    await POST(request, ctx)
    expect(approveProposal).toHaveBeenCalledWith('prop_xyz', expect.anything())
  })
})

describe('POST /api/proposals/[id] — reject', () => {
  it('rejects the proposal without touching approve', async () => {
    const { POST } = await route()
    const { request, ctx } = post({ action: 'reject', note: 'not real' })

    const res = await POST(request, ctx)

    expect(res.status).toBe(200)
    expect(rejectProposal).toHaveBeenCalledWith('p1', 'not real')
    expect(approveProposal).not.toHaveBeenCalled()
  })
})

describe('POST /api/proposals/[id] — error mapping', () => {
  /**
   * An already-reviewed proposal is a conflict, not a server error — it
   * normally means a double-click or another reviewer got there first, and the
   * UI should say so rather than showing a generic failure.
   */
  it('maps an already-reviewed proposal to 409', async () => {
    approveProposal.mockRejectedValueOnce(new ProposalNotPendingError('approved'))
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve' })

    const res = await POST(request, ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/already approved/)
  })

  it('maps an unapplicable proposal to 422', async () => {
    approveProposal.mockRejectedValueOnce(new ProposalIncompleteError('missing type'))
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve' })
    expect((await POST(request, ctx)).status).toBe(422)
  })

  it('maps an unexpected failure to 500 without leaking internals', async () => {
    approveProposal.mockRejectedValueOnce(new Error('connection string: secret'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { POST } = await route()
    const { request, ctx } = post({ action: 'approve' })

    const res = await POST(request, ctx)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(JSON.stringify(body)).not.toContain('secret')
  })
})
