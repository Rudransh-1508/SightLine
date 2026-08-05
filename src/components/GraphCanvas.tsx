'use client'

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
} from 'd3-force'
import { select } from 'd3-selection'
// Imported for its side effect: d3-transition augments d3-selection's Selection
// with .transition(), which fitToBounds uses. Without it the method is missing
// at runtime and absent from the type — the umbrella `d3` package used to pull
// it in implicitly.
import 'd3-transition'
import { zoom as d3zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom'
import { drag as d3drag } from 'd3-drag'

import { graph, CLIENT_ID, edgeKey, radiusFor, widthFor, adjacency } from '@/lib/graph'
import {
  CATEGORY_STYLE,
  STATE_COLOR,
  SURFACE,
  REGION_ANCHOR,
  TRAJECTORY_META,
  shapePath,
  stateDash,
} from '@/lib/palette'
import type { SimNode, SimEdge } from '@/lib/types'

interface Props {
  selectedId: string | null
  hoveredId: string | null
  visibleNodeIds: Set<string>
  visibleEdgeKeys: Set<string>
  onSelect: (id: string | null) => void
  onHover: (id: string | null) => void
}

const W = 1600
const H = 1100

/**
 * Renders the force-directed graph.
 *
 * Division of labour: d3-force owns the simulation maths and writes positions
 * straight to the DOM on each tick (React re-rendering 90 elements at 60fps
 * would be wasteful and janky). React owns the element structure and every
 * encoding that changes at human speed — selection, filtering, focus. The two
 * never write the same attributes.
 */
export default function GraphCanvas({
  selectedId,
  hoveredId,
  visibleNodeIds,
  visibleEdgeKeys,
  onSelect,
  onHover,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const rootRef = useRef<SVGGElement | null>(null)
  const nodeEls = useRef(new Map<string, SVGGElement>())
  const linkEls = useRef(new Map<string, SVGPathElement>())
  const simRef = useRef<Simulation<SimNode, undefined> | null>(null)
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null)

  /** Mirror of the visible set, so the imperative fit routine never reads a stale closure. */
  const visibleRef = useRef(visibleNodeIds)
  useEffect(() => {
    visibleRef.current = visibleNodeIds
  }, [visibleNodeIds])

  /** Mutable copies for the simulation — never mutate the imported data. */
  const simNodes = useMemo<SimNode[]>(
    () =>
      graph.nodes.map((n) => {
        const a = REGION_ANCHOR[n.region] ?? { x: 0.5, y: 0.5 }
        // Jitter is derived from the id rather than Math.random, so the layout
        // is reproducible run to run — and pure, which render has to be.
        return {
          ...n,
          x: a.x * W + (hash01(n.id) - 0.5) * 120,
          y: a.y * H + (hash01(`${n.id}#y`) - 0.5) * 120,
        }
      }),
    [],
  )

  /**
   * Curvature index for parallel edges. Two actors can hold more than one
   * relationship (Repsol and TotalEnergies are consortium partners *and*
   * competitors) and overlapping straight lines would hide one of them.
   */
  const simEdges = useMemo(() => {
    const byId = new Map(simNodes.map((n) => [n.id, n]))
    const pairCount = new Map<string, number>()
    const pairIndex = new Map<string, number>()
    for (const e of graph.edges) {
      const k = [e.source, e.target].sort().join('|')
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1)
    }
    return graph.edges.map((e) => {
      const k = [e.source, e.target].sort().join('|')
      const i = pairIndex.get(k) ?? 0
      pairIndex.set(k, i + 1)
      const n = pairCount.get(k)!
      return {
        ...e,
        source: byId.get(e.source)!,
        target: byId.get(e.target)!,
        curve: n === 1 ? 0 : (i - (n - 1) / 2) * 0.34,
        key: edgeKey(e),
      } as SimEdge & { curve: number; key: string }
    })
  }, [simNodes])

  /**
   * Frame the laid-out graph in the viewport. Measuring the actual node extent
   * beats any hardcoded zoom level, because the extent depends on how the
   * simulation happened to settle — and on which nodes the filters left visible.
   */
  const fitToBounds = useCallback(
    (duration = 450) => {
      const svgEl = svgRef.current
      const z = zoomRef.current
      if (!svgEl || !z) return

      const pts = simNodes.filter((n) => visibleRef.current.has(n.id))
      if (!pts.length) return

      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity
      for (const n of pts) {
        const r = radiusFor(n.influence, n.id === CLIENT_ID) + 34 // leave room for the label
        minX = Math.min(minX, (n.x ?? 0) - r)
        maxX = Math.max(maxX, (n.x ?? 0) + r)
        minY = Math.min(minY, (n.y ?? 0) - r)
        maxY = Math.max(maxY, (n.y ?? 0) + r)
      }

      const bw = maxX - minX
      const bh = maxY - minY
      if (!(bw > 0) || !(bh > 0)) return

      const k = Math.min(4, Math.max(0.35, 0.94 * Math.min(W / bw, H / bh)))
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const t = zoomIdentity
        .translate(W / 2, H / 2)
        .scale(k)
        .translate(-cx, -cy)

      const sel = select(svgEl)
      if (duration > 0) sel.transition().duration(duration).call(z.transform, t)
      else sel.call(z.transform, t)
    },
    [simNodes],
  )

  // --- simulation ---------------------------------------------------------
  useEffect(() => {
    const client = simNodes.find((n) => n.id === CLIENT_ID)!
    // Pinning the client at centre is the single biggest legibility win: the
    // subject of the analysis never wanders, so the reader keeps their bearings.
    client.fx = W / 2
    client.fy = H / 2

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          // Stronger relationships pull closer, so proximity reads as exposure.
          .distance((d) => 300 - (d.strength / 100) * 165)
          .strength((d) => 0.08 + (d.strength / 100) * 0.22),
      )
      .force(
        'charge',
        forceManyBody<SimNode>().strength((d) => -260 - d.influence * 7),
      )
      .force(
        'collide',
        forceCollide<SimNode>((d) => radiusFor(d.influence, d.id === CLIENT_ID) + 22),
      )
      // Geographic anchoring keeps the graph from collapsing into one blob.
      // Strong enough to hold regions apart, weak enough that topology still shows.
      .force(
        'x',
        forceX<SimNode>((d) => (REGION_ANCHOR[d.region]?.x ?? 0.5) * W).strength(0.16),
      )
      .force(
        'y',
        forceY<SimNode>((d) => (REGION_ANCHOR[d.region]?.y ?? 0.5) * H).strength(0.16),
      )
      .alpha(1)
      .alphaDecay(0.018)

    // Frame the graph once it settles, rather than guessing a zoom level.
    sim.on('end', () => fitToBounds(0))

    // Frame early so the reader is not left staring at an unreadable speck while
    // the layout relaxes, then again once it has actually settled.
    let ticks = 0
    sim.on('tick', () => {
      ticks++
      if (ticks === 45 || ticks === 140) fitToBounds(ticks === 45 ? 0 : 400)
      for (const n of simNodes) {
        const el = nodeEls.current.get(n.id)
        if (el) el.setAttribute('transform', `translate(${n.x!.toFixed(1)},${n.y!.toFixed(1)})`)
      }
      for (const e of simEdges) {
        const el = linkEls.current.get(e.key)
        if (el) el.setAttribute('d', arc(e))
      }
    })

    simRef.current = sim

    // --- zoom + pan -------------------------------------------------------
    const svg = select(svgRef.current!)
    const root = select(rootRef.current!)

    const z = d3zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.35, 4])
      .on('zoom', (ev) => {
        root.attr('transform', ev.transform.toString())
        // Label density is a function of zoom, applied via a data attribute so
        // CSS does the work and React never re-renders on scroll.
        const k = ev.transform.k
        rootRef.current?.setAttribute('data-zoom', k > 1.55 ? 'near' : k > 0.85 ? 'mid' : 'far')
      })

    svg.call(z)
    svg.on('dblclick.zoom', null)
    zoomRef.current = z

    // --- drag -------------------------------------------------------------
    for (const n of simNodes) {
      const el = nodeEls.current.get(n.id)
      if (!el) continue
      select<SVGGElement, unknown>(el).call(
        d3drag<SVGGElement, unknown>()
          // Without this, d3-drag swallows the click if the pointer moves even
          // one pixel between press and release — so selecting a node by
          // clicking it fails for anyone without a perfectly steady hand.
          .clickDistance(8)
          .on('start', (ev) => {
            if (!ev.active) sim.alphaTarget(0.24).restart()
            n.fx = n.x
            n.fy = n.y
          })
          .on('drag', (ev) => {
            n.fx = ev.x
            n.fy = ev.y
          })
          .on('end', (ev) => {
            if (!ev.active) sim.alphaTarget(0)
            // The client stays pinned; everything else is released back to the sim.
            if (n.id !== CLIENT_ID) {
              n.fx = null
              n.fy = null
            }
          }),
      )
    }

    return () => {
      sim.stop()
      simRef.current = null
      svg.on('.zoom', null)
    }
  }, [simNodes, simEdges, fitToBounds])

  // Focus mode: one hop from the active node stays lit, everything else recedes.
  const active = hoveredId ?? selectedId
  const neighbours = active ? adjacency.get(active) : null

  function nodeDim(id: string): boolean {
    if (!visibleNodeIds.has(id)) return true
    if (!active) return false
    return id !== active && !neighbours?.has(id)
  }

  function edgeDim(e: SimEdge & { key: string }): boolean {
    if (!visibleEdgeKeys.has(e.key)) return true
    if (!active) return false
    return e.source.id !== active && e.target.id !== active
  }

  return (
    <div className="relative h-full w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-full w-full cursor-grab active:cursor-grabbing"
        onClick={() => onSelect(null)}
      >
        <defs>
          <radialGradient id="clientGlow">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g ref={rootRef} data-zoom="far">
          {/* Links first so nodes always sit above them. */}
          <g>
            {simEdges.map((e) => {
              const dim = edgeDim(e)
              const focused = !!active && (e.source.id === active || e.target.id === active)
              return (
                <path
                  key={e.key}
                  ref={(el) => {
                    if (el) linkEls.current.set(e.key, el)
                    else linkEls.current.delete(e.key)
                  }}
                  fill="none"
                  stroke={STATE_COLOR[e.state]}
                  strokeWidth={widthFor(e.strength) * (focused ? 1.7 : 1)}
                  strokeDasharray={stateDash(e.state)}
                  strokeLinecap="round"
                  opacity={dim ? 0.045 : focused ? 0.95 : 0.42}
                  style={{ transition: 'opacity 220ms, stroke-width 220ms' }}
                  pointerEvents="none"
                />
              )
            })}
          </g>

          {/* Trajectory glyphs, only for the focused node's edges — otherwise clutter. */}
          <g>
            {active &&
              simEdges
                .filter((e) => !edgeDim(e) && e.trajectory !== 'stable')
                .map((e) => <TrajectoryGlyph key={`t-${e.key}`} edge={e} />)}
          </g>

          <g>
            {simNodes.map((n) => {
              const style = CATEGORY_STYLE[n.category]
              const isClient = n.id === CLIENT_ID
              const r = radiusFor(n.influence, isClient)
              const dim = nodeDim(n.id)
              const isActive = n.id === active
              const isSelected = n.id === selectedId
              // Minor labels are hidden until the reader zooms in or focuses.
              const major = isClient || n.influence >= 70

              return (
                <g
                  key={n.id}
                  ref={(el) => {
                    if (el) nodeEls.current.set(n.id, el)
                    else nodeEls.current.delete(n.id)
                  }}
                  className="cursor-pointer"
                  role="button"
                  aria-label={`${n.name} — ${style.label}, influence ${n.influence} of 100`}
                  opacity={dim ? 0.08 : 1}
                  style={{ transition: 'opacity 220ms' }}
                  pointerEvents={dim ? 'none' : 'all'}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    onSelect(isSelected ? null : n.id)
                  }}
                  onMouseEnter={() => onHover(n.id)}
                  onMouseLeave={() => onHover(null)}
                >
                  {isClient && (
                    <circle r={r * 3.2} fill="url(#clientGlow)" pointerEvents="none" />
                  )}

                  {/* Invisible generous hit target — the glyph itself is small. */}
                  <circle r={r + 10} fill="transparent" />

                  {(isActive || isSelected) && (
                    <path
                      d={shapePath(style.shape, r + 7)}
                      fill="none"
                      stroke={SURFACE.ink}
                      strokeWidth={1.4}
                      opacity={0.8}
                    />
                  )}

                  <path
                    d={shapePath(style.shape, r)}
                    fill={isClient ? 'none' : style.color}
                    stroke={isClient ? style.color : SURFACE.page}
                    strokeWidth={isClient ? 2.5 : 1.75}
                  />

                  <text
                    y={r + 15}
                    textAnchor="middle"
                    fontSize={isClient ? 15 : 11.5}
                    fontWeight={isClient ? 600 : 500}
                    fill={isClient ? SURFACE.ink : SURFACE.inkSecondary}
                    className={major ? 'gc-label-major' : 'gc-label-minor'}
                    data-forced={isActive || isSelected ? 'true' : undefined}
                    pointerEvents="none"
                    style={{ paintOrder: 'stroke', stroke: SURFACE.page, strokeWidth: 3.5 }}
                  >
                    {n.name}
                  </text>
                </g>
              )
            })}
          </g>
        </g>
      </svg>

      <button
        onClick={() => fitToBounds()}
        className="absolute bottom-4 right-4 rounded border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-neutral-300 backdrop-blur transition hover:bg-white/10"
      >
        Reset view
      </button>
    </div>
  )
}

/** Deterministic 0..1 from a string (FNV-1a), used for reproducible layout jitter. */
function hash01(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 100000) / 100000
}

/** Quadratic arc between two nodes; straight when there is no parallel edge. */
function arc(e: SimEdge & { curve: number }): string {
  const { source: s, target: t, curve } = e
  const x1 = s.x ?? 0,
    y1 = s.y ?? 0,
    x2 = t.x ?? 0,
    y2 = t.y ?? 0
  if (!curve) return `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`
  const mx = (x1 + x2) / 2,
    my = (y1 + y2) / 2
  const dx = x2 - x1,
    dy = y2 - y1
  const cx = mx - dy * curve * 0.5
  const cy = my + dx * curve * 0.5
  return `M${x1.toFixed(1)},${y1.toFixed(1)}Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`
}

/** Direction-of-travel marker placed at the midpoint of a focused edge. */
function TrajectoryGlyph({ edge }: { edge: SimEdge & { curve: number; key: string } }) {
  const ref = useRef<SVGTextElement | null>(null)
  useEffect(() => {
    let raf = 0
    const step = () => {
      const el = ref.current
      if (el) {
        const { source: s, target: t, curve } = edge
        const mx = ((s.x ?? 0) + (t.x ?? 0)) / 2
        const my = ((s.y ?? 0) + (t.y ?? 0)) / 2
        const dx = (t.x ?? 0) - (s.x ?? 0)
        const dy = (t.y ?? 0) - (s.y ?? 0)
        el.setAttribute('x', String(mx - (dy * curve * 0.5) / 2))
        el.setAttribute('y', String(my + (dx * curve * 0.5) / 2))
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [edge])

  const meta = TRAJECTORY_META[edge.trajectory]
  return (
    <text
      ref={ref}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={11}
      fill={meta.color}
      pointerEvents="none"
      style={{ paintOrder: 'stroke', stroke: SURFACE.page, strokeWidth: 3 }}
    >
      {meta.glyph}
    </text>
  )
}
