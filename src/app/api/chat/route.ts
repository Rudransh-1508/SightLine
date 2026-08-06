import { NextResponse } from 'next/server'

import { requireUser } from '@/lib/auth'
import { buildCopilotContext } from '@/lib/copilot/context'
import { runCopilot, type CopilotEvent } from '@/lib/copilot/agent'
import { createToolRunner } from '@/lib/copilot/tools'
import {
  CREDIT_COSTS,
  InsufficientCreditsError,
  getBalance,
  refund,
  reserve,
  settle,
  type MeteredFeature,
} from '@/lib/credits'
import { getOpenRouterClient } from '@/lib/llm/openrouter'

/**
 * The grounded copilot: POST a question, stream back an answer with citations.
 *
 * Metering, in order, and the order is the design:
 *
 *  1. Verify the session HERE (`requireUser`), not in src/proxy.ts — Next's own
 *     docs say proxy is an optimistic check and not an authorization boundary.
 *  2. Reserve credits BEFORE the provider is contacted, at the higher of the
 *     two copilot prices. A caller who cannot afford the worst case gets 402
 *     and no model call is made at all (CLAUDE.md).
 *  3. Settle down to the cheaper price once the answer is in and the tool count
 *     is known; refund in full if the run throws.
 *
 * The response is NDJSON — one JSON object per line — rather than SSE, because
 * the stream carries structured events (tool calls, citations) as well as text,
 * and SSE's text-oriented framing would mean encoding JSON inside `data:` lines
 * for no gain. Consumers split on newlines.
 */

const DEFAULT_DATASET = 'repsol-demo'

/** Cost table (CLAUDE.md): 3 up to two tool calls, 5 beyond that. */
const SIMPLE_TOOL_CALL_LIMIT = 2

function featureFor(toolCallCount: number): MeteredFeature {
  return toolCallCount > SIMPLE_TOOL_CALL_LIMIT ? 'copilot_complex' : 'copilot_simple'
}

export async function POST(request: Request) {
  let user
  try {
    user = await requireUser()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { question?: unknown; dataset?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 })
  }
  if (question.length > 2000) {
    return NextResponse.json(
      { error: 'question is too long (max 2000 chars)' },
      { status: 400 },
    )
  }

  const slug = typeof body.dataset === 'string' && body.dataset ? body.dataset : DEFAULT_DATASET

  const model = process.env.OPENROUTER_COPILOT_MODEL
  if (!model) {
    console.error('OPENROUTER_COPILOT_MODEL is not set')
    return NextResponse.json({ error: 'Copilot is not configured' }, { status: 503 })
  }

  const built = await buildCopilotContext(slug)
  if (!built) {
    return NextResponse.json({ error: `Unknown dataset "${slug}"` }, { status: 404 })
  }

  // Everything that can fail cheaply has now failed. Reserve at the worst-case
  // price; a caller short of credits never reaches the provider.
  let reservation
  try {
    reservation = await reserve(user.id, 'copilot_complex', undefined)
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return NextResponse.json(
        { error: err.message, required: err.required, available: err.available },
        { status: 402 },
      )
    }
    throw err
  }

  const runner = createToolRunner(built.context)
  const client = getOpenRouterClient()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: CopilotEvent | Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }

      try {
        const result = await runCopilot({
          client,
          model,
          question,
          runner,
          onEvent: send,
        })

        const feature = featureFor(result.toolCallCount)
        await settle(reservation, feature)

        send({
          type: 'done',
          toolCalls: result.toolCallCount,
          creditsCharged: CREDIT_COSTS[feature],
          balance: await getBalance(user.id),
          unverified: result.unverified,
        })
      } catch (err) {
        /*
         * The 200 and the first bytes are already on the wire by the time most
         * failures happen, so the error is delivered as a stream event rather
         * than a status code. The refund is the part that must not be skipped:
         * a crashed call must never bill.
         */
        await refund(reservation, 'refund: copilot failed')
        console.error('copilot run failed:', err)
        send({ type: 'error', message: 'The copilot failed to answer. You were not charged.' })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Disables proxy buffering, which would otherwise defeat streaming.
      'X-Accel-Buffering': 'no',
    },
  })
}
