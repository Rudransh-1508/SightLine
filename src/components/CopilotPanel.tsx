'use client'

import { useCallback, useMemo, useRef, useState } from 'react'

import { edgeKey } from '@/lib/graph'
import {
  readChatStream,
  parseAnswer,
  parseEdgeId,
  type AnswerSegment,
  type ChatEvent,
} from '@/lib/copilot/events'
import { CATEGORY_STYLE, REL_TYPE_LABEL, STATE_COLOR } from '@/lib/palette'
import type { RelationshipEdge } from '@/lib/types'
import { useGraph } from './GraphProvider'

/**
 * The copilot panel: ask a question, watch the answer arrive, click a citation
 * to steer the graph.
 *
 * Citations are resolved against the graph this component already holds, not
 * taken on trust from the response. An id the local graph does not know is
 * rendered as an inert, visibly-flagged chip rather than a clickable control —
 * so a model that invents a reference produces something obviously wrong
 * instead of a link that quietly goes nowhere. The server checks the same
 * thing independently (agent.ts) and reports it in `unverified`; both checks
 * exist because this is the failure mode that would discredit the tool.
 */

export interface CopilotFocus {
  nodes: Set<string>
  edges: Set<string>
}

interface Props {
  /** Cited subgraph to highlight, or null to release the graph. */
  onFocus: (focus: CopilotFocus | null) => void
  /** Opens an actor in the detail sidebar. */
  onSelect: (id: string) => void
  /** Latest balance from a completed answer, for the header. */
  onBalanceChange: (balance: number) => void
}

type Status = 'idle' | 'streaming' | 'done' | 'error'

interface Meta {
  toolCalls: number
  creditsCharged: number
  unverified: string[]
}

const SUGGESTIONS = [
  'What is our Algeria exposure?',
  'Which of our relationships are deteriorating, and which matters most?',
  'How does the CNMC reach us?',
]

export default function CopilotPanel({ onFocus, onSelect, onBalanceChange }: Props) {
  const { nodeById, data: graph, clientId, datasetSlug } = useGraph()
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [activity, setActivity] = useState<string[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const edgeById = useMemo(() => {
    const map = new Map<string, RelationshipEdge>()
    for (const e of graph.edges) map.set(edgeKey(e), e)
    return map
  }, [graph.edges])

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || status === 'streaming') return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setAsked(trimmed)
      setQuestion('')
      setAnswer('')
      setActivity([])
      setMeta(null)
      setError(null)
      setStatus('streaming')
      onFocus(null)

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: trimmed, dataset: datasetSlug }),
          signal: controller.signal,
        })

        /*
         * An expired session is redirected to the sign-in page by proxy.ts, so
         * this arrives as a followed redirect carrying HTML with a 200 — not
         * as a 401. Checking the content type catches that; without it the
         * stream parser would silently chew through a login page and report
         * nothing at all.
         */
        const isStream = res.headers.get('Content-Type')?.includes('ndjson')
        if (res.ok && !isStream) {
          setError('Your session has expired. Reload the page to sign in again.')
          setStatus('error')
          return
        }

        if (!res.ok || !res.body) {
          // 402 and 400 arrive as JSON, before any streaming starts.
          const body = await res.json().catch(() => ({}))
          setError(
            res.status === 402
              ? `Not enough credits: this question needs ${body.required ?? 5}, you have ${body.available ?? 0}.`
              : (body.error ?? `Request failed (${res.status})`),
          )
          setStatus('error')
          return
        }

        await readChatStream(res.body, (event: ChatEvent) => {
          switch (event.type) {
            case 'delta':
              setAnswer((prev) => prev + event.text)
              break
            case 'reset':
              // Prose the model wrote before deciding to call a tool.
              setAnswer('')
              break
            case 'tool_call':
              setActivity((prev) => [...prev, event.name])
              break
            case 'citations':
              onFocus(
                event.nodes.length || event.edges.length
                  ? { nodes: new Set(event.nodes), edges: new Set(event.edges) }
                  : null,
              )
              break
            case 'done':
              setMeta({
                toolCalls: event.toolCalls,
                creditsCharged: event.creditsCharged,
                unverified: event.unverified,
              })
              onBalanceChange(event.balance)
              setStatus('done')
              break
            case 'error':
              setError(event.message)
              setStatus('error')
              break
          }
        })

        // A stream that ends without a done event failed in transit.
        setStatus((prev) => (prev === 'streaming' ? 'error' : prev))
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setError('The connection dropped before the answer finished.')
        setStatus('error')
      }
    },
    [status, datasetSlug, onFocus, onBalanceChange],
  )

  const { blocks } = parseAnswer(answer)

  const clear = () => {
    abortRef.current?.abort()
    setAsked(null)
    setAnswer('')
    setActivity([])
    setMeta(null)
    setError(null)
    setStatus('idle')
    onFocus(null)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {!asked && <Intro onPick={ask} />}

        {asked && (
          <>
            <p className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">Question</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-neutral-300">{asked}</p>

            {activity.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {activity.map((name, i) => (
                  <span
                    key={`${name}-${i}`}
                    className="rounded border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-neutral-500"
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}

            {error ? (
              <p className="mt-4 rounded border border-red-400/25 bg-red-400/[0.07] px-3 py-2 text-[12.5px] leading-relaxed text-red-200/90">
                {error}
              </p>
            ) : (
              <div className="mt-4 space-y-2 text-[13.5px] leading-relaxed text-neutral-200">
                {blocks.map((block, bi) => {
                  const inline = block.segments.map((seg, i) => (
                    <Segment
                      key={i}
                      segment={seg}
                      nodeName={(id) => nodeById.get(id)?.name}
                      nodeColor={(id) => {
                        const n = nodeById.get(id)
                        return n ? CATEGORY_STYLE[n.category].color : null
                      }}
                      edge={(id) => edgeById.get(id) ?? null}
                      counterpartName={(id) => nodeById.get(id)?.name ?? id}
                      onSelectNode={onSelect}
                      onSelectEdge={(e) =>
                        onSelect(e.source === clientId ? e.target : e.source)
                      }
                    />
                  ))
                  const isLast = bi === blocks.length - 1
                  const caret = status === 'streaming' && isLast && <Caret />

                  return block.kind === 'bullet' ? (
                    <div key={bi} className="flex gap-2">
                      <span className="mt-[7px] h-[3px] w-[3px] shrink-0 rounded-full bg-neutral-500" />
                      <p className="min-w-0 flex-1">
                        {inline}
                        {caret}
                      </p>
                    </div>
                  ) : (
                    <p key={bi}>
                      {inline}
                      {caret}
                    </p>
                  )
                })}
                {blocks.length === 0 && status === 'streaming' && <Caret />}
              </div>
            )}

            {meta && (
              <div className="mt-4 border-t border-white/10 pt-3">
                <p className="text-[11px] text-neutral-500">
                  {meta.toolCalls} graph {meta.toolCalls === 1 ? 'query' : 'queries'} ·{' '}
                  {meta.creditsCharged} credits
                </p>
                {meta.unverified.length > 0 && (
                  <p className="mt-2 rounded border border-amber-400/25 bg-amber-400/[0.07] px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-200/85">
                    {meta.unverified.length} citation
                    {meta.unverified.length === 1 ? '' : 's'} referenced something no graph
                    query returned and {meta.unverified.length === 1 ? 'was' : 'were'} not
                    linked: <span className="font-mono">{meta.unverified.join(', ')}</span>
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <form
        className="shrink-0 border-t border-white/10 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault()
          void ask(question)
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask(question)
              }
            }}
            rows={2}
            placeholder="Ask about the network…"
            aria-label="Ask the copilot"
            className="min-h-[46px] flex-1 resize-none rounded border border-white/10 bg-white/[0.03] px-2.5 py-2 text-[12.5px] text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-white/25"
          />
          <button
            type="submit"
            disabled={status === 'streaming' || !question.trim()}
            className="rounded border border-white/10 px-2.5 py-1.5 text-[11px] text-neutral-300 transition enabled:hover:bg-white/[0.06] disabled:opacity-40"
          >
            {status === 'streaming' ? '…' : 'Ask'}
          </button>
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[10px] text-neutral-600">
            3 credits · 5 for a path-finding question
          </span>
          {asked && (
            <button
              type="button"
              onClick={clear}
              className="text-[10px] text-neutral-500 transition hover:text-neutral-300"
            >
              Clear
            </button>
          )}
        </div>
      </form>
    </div>
  )
}

/**
 * One segment of the answer: prose, or a citation chip.
 *
 * An id that does not resolve in the local graph is deliberately not a button —
 * it renders struck-through and flagged, so an invented reference is visible as
 * a defect rather than dressed up as a working link.
 */
function Segment({
  segment,
  nodeName,
  nodeColor,
  edge,
  counterpartName,
  onSelectNode,
  onSelectEdge,
}: {
  segment: AnswerSegment
  nodeName: (id: string) => string | undefined
  nodeColor: (id: string) => string | null
  edge: (id: string) => RelationshipEdge | null
  counterpartName: (id: string) => string
  onSelectNode: (id: string) => void
  onSelectEdge: (edge: RelationshipEdge) => void
}) {
  if (segment.kind === 'text') return <span>{segment.text}</span>
  if (segment.kind === 'bold')
    return <strong className="font-semibold text-neutral-100">{segment.text}</strong>

  if (segment.kind === 'node') {
    const name = nodeName(segment.id)
    if (!name) return <Unresolved label={segment.id} />
    const color = nodeColor(segment.id) ?? undefined
    return (
      <button
        onClick={() => onSelectNode(segment.id)}
        className="mx-[1px] inline-flex items-center gap-1 rounded border px-1.5 py-[1px] align-baseline text-[12px] transition hover:brightness-125"
        style={{ borderColor: `${color}55`, background: `${color}14`, color }}
        title={`Show ${name}`}
      >
        {name}
      </button>
    )
  }

  const found = edge(segment.id)
  if (!found) return <Unresolved label={segment.id} />
  const parts = parseEdgeId(segment.id)
  return (
    <button
      onClick={() => onSelectEdge(found)}
      className="mx-[1px] inline-flex items-center gap-1 rounded border px-1.5 py-[1px] align-baseline text-[12px] transition hover:brightness-125"
      style={{
        borderColor: `${STATE_COLOR[found.state]}55`,
        background: `${STATE_COLOR[found.state]}14`,
        color: STATE_COLOR[found.state],
      }}
      title={`${REL_TYPE_LABEL[found.type]} · ${found.exposure}`}
    >
      {counterpartName(parts?.source ?? found.source)} →{' '}
      {counterpartName(parts?.target ?? found.target)}
    </button>
  )
}

/** Streaming cursor, shown at the end of whatever block is still growing. */
function Caret() {
  return (
    <span className="ml-0.5 inline-block h-[13px] w-[7px] translate-y-[2px] animate-pulse bg-neutral-400" />
  )
}

function Unresolved({ label }: { label: string }) {
  return (
    <span
      className="mx-[1px] rounded border border-amber-400/30 bg-amber-400/[0.07] px-1.5 py-[1px] font-mono text-[11px] text-amber-200/80 line-through"
      title="This reference does not exist in the graph and was not linked"
    >
      {label}
    </span>
  )
}

function Intro({ onPick }: { onPick: (q: string) => void }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">Copilot</p>
      <p className="mt-3 text-[13px] leading-relaxed text-neutral-400">
        Ask about the network in plain language. Every answer is built from queries against this
        graph, and each claim links back to the actor or relationship it came from — clicking
        one focuses the map.
      </p>
      <div className="mt-4 space-y-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => void onPick(s)}
            className="block w-full rounded border border-white/10 px-2.5 py-1.5 text-left text-[12px] text-neutral-300 transition hover:bg-white/[0.05]"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}
