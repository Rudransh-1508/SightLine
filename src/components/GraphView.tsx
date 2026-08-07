'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import GraphCanvas from './GraphCanvas'
import DetailPanel from './DetailPanel'
import CopilotPanel, { type CopilotFocus } from './CopilotPanel'
import Controls, { type FilterState, type ViewState } from './Controls'
import { edgeKey } from '@/lib/graph'
import { useGraph } from './GraphProvider'
import {
  CATEGORY_ORDER,
  STATE_ORDER,
  TRAJECTORY_ORDER,
  STATE_COLOR,
  STATE_LABEL,
  TRAJECTORY_META,
} from '@/lib/palette'
import type { Category, RelState, Trajectory } from '@/lib/types'

export default function GraphView({ initialCredits }: { initialCredits: number }) {
  const {
    data: graph,
    clientId: CLIENT_ID,
    nodeById,
    summarise,
    datasetName,
    datasetKind,
  } = useGraph()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [showNote, setShowNote] = useState(true)
  const [view, setView] = useState<ViewState>({ size: 'influence', color: 'category' })
  const [panel, setPanel] = useState<'copilot' | 'detail'>('copilot')
  const [credits, setCredits] = useState(initialCredits)
  /** The subgraph an answer cited, or null when the graph is unconstrained. */
  const [answerFocus, setAnswerFocus] = useState<CopilotFocus | null>(null)
  const isIllustrative = datasetKind === 'illustrative'
  const [filters, setFilters] = useState<FilterState>({
    categories: new Set<Category>(CATEGORY_ORDER),
    states: new Set<RelState>(STATE_ORDER),
    trajectories: new Set<Trajectory>(TRAJECTORY_ORDER),
    minStrength: 0,
    query: '',
  })

  const summary = useMemo(() => summarise(), [summarise])

  // Escape is the expected way out of a focused view — first the selection,
  // then the answer's focus, so one key backs all the way out to the whole map.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSelectedId((current) => {
        if (current) return null
        setAnswerFocus(null)
        return null
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Selecting an actor anywhere shows its profile, so switch to that panel. */
  const selectAndShowDetail = useCallback((id: string | null) => {
    setSelectedId(id)
    if (id) setPanel('detail')
  }, [])

  /**
   * Filtering is computed here and pushed down as visibility sets. Nodes are
   * never removed from the simulation — they are dimmed in place, so the layout
   * never reflows and the reader keeps the mental map they just built.
   */
  const { visibleNodeIds, visibleEdgeKeys } = useMemo(() => {
    const q = filters.query.trim().toLowerCase()

    const passesBase = (id: string) => {
      const n = nodeById.get(id)!
      if (n.id === CLIENT_ID) return true
      if (!filters.categories.has(n.category)) return false
      if (q && !`${n.name} ${n.role} ${n.country} ${n.region}`.toLowerCase().includes(q)) {
        return false
      }
      return true
    }

    const edges = new Set<string>()
    const touched = new Set<string>()
    for (const e of graph.edges) {
      if (!filters.states.has(e.state)) continue
      if (!filters.trajectories.has(e.trajectory)) continue
      if (e.strength < filters.minStrength) continue
      if (!passesBase(e.source) || !passesBase(e.target)) continue
      edges.add(edgeKey(e))
      touched.add(e.source)
      touched.add(e.target)
    }

    const nodes = new Set<string>()
    for (const n of graph.nodes) {
      if (!passesBase(n.id)) continue
      // An isolated node carries no relationship information — drop it.
      if (n.id !== CLIENT_ID && !touched.has(n.id)) continue
      nodes.add(n.id)
    }
    nodes.add(CLIENT_ID)

    /*
     * An answer steers the graph by narrowing the same visibility sets the
     * filters use, rather than through a parallel highlighting mechanism. The
     * canvas therefore needs no knowledge of the copilot at all: it keeps
     * dimming whatever is not visible, the layout never reflows, and Escape
     * and the filter controls behave exactly as they did before.
     */
    if (answerFocus) {
      for (const key of edges) if (!answerFocus.edges.has(key)) edges.delete(key)
      const kept = new Set(answerFocus.nodes)
      for (const key of edges) {
        const edge = graph.edges.find((e) => edgeKey(e) === key)
        if (edge) {
          kept.add(edge.source)
          kept.add(edge.target)
        }
      }
      for (const id of nodes) if (!kept.has(id)) nodes.delete(id)
    }

    return { visibleNodeIds: nodes, visibleEdgeKeys: edges }
  }, [filters, graph.nodes, graph.edges, nodeById, CLIENT_ID, answerFocus])

  return (
    <div className="flex h-dvh flex-col bg-[#0b0b0a] text-neutral-200">
      {/* ---- header ---------------------------------------------------- */}
      <header className="shrink-0 border-b border-white/10 px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-3">
            <h1 className="text-[15px] font-semibold tracking-tight text-neutral-100">
              Sightline
            </h1>
            {/* Dataset-driven rather than hardcoded: the same view renders the
                illustrative demo and the sourced live graph. */}
            <span className="text-[12px] text-neutral-400">{datasetName}</span>
            <span className="text-[11px] text-neutral-500">
              {graph.nodes.length} actors · {graph.edges.length} relationships · as of{' '}
              {graph.asOf}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {STATE_ORDER.map((s) => (
              <div key={s} className="flex items-center gap-1.5" title={STATE_LABEL[s]}>
                <span
                  className="h-[3px] w-4 rounded-full"
                  style={{ background: STATE_COLOR[s] }}
                />
                <span className="text-[11px] tabular-nums text-neutral-400">
                  {summary.byState[s]}
                </span>
              </div>
            ))}
            <span className="text-[11px] text-neutral-600">|</span>
            <span className="text-[11px] text-neutral-400">
              <span style={{ color: TRAJECTORY_META.deteriorating.color }}>▼</span>{' '}
              {summary.deteriorating} deteriorating
            </span>
            <span className="text-[11px] text-neutral-400">
              <span style={{ color: TRAJECTORY_META.improving.color }}>▲</span>{' '}
              {summary.improving} improving
            </span>
            <span
              className="text-[11px] tabular-nums text-neutral-400"
              title="Credits. Only generation and extraction cost anything — the graph, filters and all analytics are free."
            >
              {credits} credits
            </span>
            <Link
              href="/review"
              className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-neutral-400 transition hover:bg-white/[0.06] hover:text-neutral-200"
            >
              Review queue
            </Link>
          </div>
        </div>

        {showNote && isIllustrative && (
          <div className="mt-2.5 flex items-start gap-2 rounded border border-amber-400/25 bg-amber-400/[0.07] px-3 py-1.5">
            <p className="flex-1 text-[11px] leading-relaxed text-amber-200/85">
              <strong className="font-semibold">Illustrative data.</strong> Organisation and
              individual names are real, but every relationship state, score, event and
              assessment shown here is invented for a technical assignment. Nothing on this page
              is reporting, or a factual claim about any real entity or person.
            </p>
            <button
              onClick={() => setShowNote(false)}
              className="shrink-0 text-[11px] text-amber-200/60 transition hover:text-amber-200"
              aria-label="Dismiss notice"
            >
              ✕
            </button>
          </div>
        )}
      </header>

      {/* ---- body ------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className="order-2 w-full shrink-0 border-white/10 lg:order-1 lg:w-[212px] lg:border-r">
          <Controls
            filters={filters}
            onChange={setFilters}
            view={view}
            onViewChange={setView}
            visibleCount={visibleEdgeKeys.size}
            totalCount={graph.edges.length}
          />
        </aside>

        <main className="relative order-1 min-h-[54vh] flex-1 lg:order-2 lg:min-h-0">
          {answerFocus && (
            <div className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded border border-white/15 bg-black/70 px-2.5 py-1 backdrop-blur">
              <span className="text-[11px] text-neutral-300">
                Focused on the answer · {visibleNodeIds.size} actors, {visibleEdgeKeys.size}{' '}
                relationships
              </span>
              <button
                onClick={() => setAnswerFocus(null)}
                className="text-[11px] text-neutral-500 transition hover:text-neutral-200"
              >
                Show all
              </button>
            </div>
          )}
          <GraphCanvas
            selectedId={selectedId}
            hoveredId={hoveredId}
            visibleNodeIds={visibleNodeIds}
            visibleEdgeKeys={visibleEdgeKeys}
            view={view}
            onSelect={selectAndShowDetail}
            onHover={setHoveredId}
          />
        </main>

        <aside className="order-3 flex w-full shrink-0 flex-col border-white/10 lg:w-[352px] lg:border-l">
          <div className="flex shrink-0 border-b border-white/10">
            {(
              [
                ['copilot', 'Ask'],
                ['detail', 'Detail'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setPanel(key)}
                className={`flex-1 px-3 py-2 text-[11px] uppercase tracking-[0.14em] transition ${
                  panel === key
                    ? 'border-b border-neutral-200 text-neutral-100'
                    : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/*
           * Both panels stay mounted: unmounting the copilot would throw away
           * an answer the moment the reader clicked one of its own citations,
           * which is the interaction the whole feature exists for.
           */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <div className={panel === 'copilot' ? 'h-full' : 'hidden'}>
              <CopilotPanel
                onFocus={setAnswerFocus}
                onSelect={selectAndShowDetail}
                onBalanceChange={setCredits}
              />
            </div>
            <div className={panel === 'detail' ? 'h-full' : 'hidden'}>
              <DetailPanel selectedId={selectedId} onSelect={setSelectedId} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}
