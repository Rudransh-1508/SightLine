import { NextResponse } from 'next/server'

import { requireUser } from '@/lib/auth'
import {
  approveProposal,
  rejectProposal,
  ProposalNotPendingError,
  ProposalIncompleteError,
} from '@/lib/review'

/**
 * Approve or reject a staged proposal.
 *
 * Costs ZERO credits — per CLAUDE.md, approving or rejecting a proposal calls
 * no model, it is a deterministic database operation. Only generation and
 * extraction are metered.
 *
 * Authorization is verified here with `requireUser()`, not delegated to
 * src/proxy.ts: Next's docs are explicit that proxy is for optimistic checks
 * and must not be relied on as the security boundary.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireUser()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Next.js 16: route params are async and must be awaited.
  const { id } = await ctx.params

  let body: { action?: string; note?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (body.action !== 'approve' && body.action !== 'reject') {
    return NextResponse.json({ error: 'action must be "approve" or "reject"' }, { status: 400 })
  }

  try {
    if (body.action === 'approve') {
      const result = await approveProposal(id, { note: body.note })
      return NextResponse.json({ ok: true, ...result })
    }
    await rejectProposal(id, body.note)
    return NextResponse.json({ ok: true })
  } catch (err) {
    // A proposal that is no longer pending is a conflict, not a server error —
    // it usually means someone else reviewed it first, or a double-click.
    if (err instanceof ProposalNotPendingError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    if (err instanceof ProposalIncompleteError) {
      return NextResponse.json({ error: err.message }, { status: 422 })
    }
    console.error('proposal review failed:', err)
    return NextResponse.json({ error: 'Review failed' }, { status: 500 })
  }
}
