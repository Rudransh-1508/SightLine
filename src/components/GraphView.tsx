'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import GraphCanvas from './GraphCanvas'
import DetailPanel from './DetailPanel'
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

export default function GraphView() {
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
  const isIllustrative = datasetKind === 'illustrative'
  const [filters, setFilters] = useState<FilterState>({
    categories: new Set<Category>(CATEGORY_ORDER),
    states: new Set<RelState>(STATE_ORDER),
    trajectories: new Set<Trajectory>(TRAJECTORY_ORDER),
    minStrength: 0,
    query: '',
  })

  const summary = useMemo(() => summarise(), [summarise])

  // Escape is the expected way out of a focused view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

    return { visibleNodeIds: nodes, visibleEdgeKeys: edges }
  }, [filters, graph.nodes, graph.edges, nodeById, CLIENT_ID])

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

        <main className="order-1 min-h-[54vh] flex-1 lg:order-2 lg:min-h-0">
          <GraphCanvas
            selectedId={selectedId}
            hoveredId={hoveredId}
            visibleNodeIds={visibleNodeIds}
            visibleEdgeKeys={visibleEdgeKeys}
            view={view}
            onSelect={setSelectedId}
            onHover={setHoveredId}
          />
        </main>

        <aside className="order-3 w-full shrink-0 border-white/10 lg:w-[352px] lg:border-l">
          <DetailPanel selectedId={selectedId} onSelect={setSelectedId} />
        </aside>
      </div>
    </div>
  )
}
