'use client'

import {
  CATEGORY_STYLE,
  STATE_COLOR,
  STATE_LABEL,
  TRAJECTORY_META,
  REL_TYPE_LABEL,
  CONFIDENCE_LABEL,
  SURFACE,
  shapePath,
} from '@/lib/palette'
import {
  nodeById,
  edgesFor,
  clientEdgesFor,
  leverageLabel,
  degree,
  CLIENT_ID,
  graph,
} from '@/lib/graph'
import type { RelationshipEdge } from '@/lib/types'

interface Props {
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export default function DetailPanel({ selectedId, onSelect }: Props) {
  if (!selectedId) return <EmptyState />

  const node = nodeById.get(selectedId)
  if (!node) return <EmptyState />

  const style = CATEGORY_STYLE[node.category]
  const isClient = node.id === CLIENT_ID
  const clientEdges = isClient ? [] : clientEdgesFor(node.id)
  const others = edgesFor(node.id).filter(({ other }) => isClient || other.id !== CLIENT_ID)

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-b border-white/10 px-5 py-4">
        <div className="flex items-start gap-3">
          <svg width="26" height="26" viewBox="-13 -13 26 26" className="mt-0.5 shrink-0">
            <path
              d={shapePath(style.shape, 9)}
              fill={isClient ? 'none' : style.color}
              stroke={isClient ? style.color : 'none'}
              strokeWidth={2}
            />
          </svg>
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold leading-snug text-neutral-100">
              {node.name}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-neutral-400">{node.role}</p>
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-3 gap-3 text-[11px]">
          <Stat label="Type" value={style.label} />
          <Stat label="Base" value={node.country} />
          <Stat label="Influence" value={`${node.influence}/100`} />
          <Stat label="Region" value={node.region} />
          <Stat label="Links" value={String(degree.get(node.id) ?? 0)} />
          {node.keyPeople?.length ? (
            <Stat label="Key people" value={node.keyPeople.join(', ')} />
          ) : null}
        </dl>
      </header>

      <section className="border-b border-white/10 px-5 py-4">
        <SectionLabel>Profile</SectionLabel>
        <p className="mt-2 text-[13px] leading-relaxed text-neutral-300">{node.description}</p>
      </section>

      {clientEdges.length > 0 && (
        <section className="border-b border-white/10 px-5 py-4">
          <SectionLabel>
            {clientEdges.length > 1
              ? `Relationships with Repsol (${clientEdges.length})`
              : 'Relationship with Repsol'}
          </SectionLabel>
          {clientEdges.map((edge, i) => (
            <div
              key={`${edge.source}-${edge.target}-${edge.type}`}
              className={i > 0 ? 'mt-5 border-t border-white/10 pt-4' : undefined}
            >
              <EdgeCard edge={edge} expanded />
            </div>
          ))}
        </section>
      )}

      {others.length > 0 && (
        <section className="px-5 py-4">
          <SectionLabel>
            {isClient
              ? `Direct relationships (${others.length})`
              : `Other connections (${others.length})`}
          </SectionLabel>
          <ul className="mt-2 space-y-1.5">
            {others.map(({ edge, other }) => (
              <li key={`${edge.source}-${edge.target}-${edge.type}`}>
                <button
                  onClick={() => onSelect(other.id)}
                  className="flex w-full items-center gap-2.5 rounded border border-transparent px-2 py-1.5 text-left transition hover:border-white/10 hover:bg-white/[0.04]"
                >
                  <span
                    className="h-[3px] w-6 shrink-0 rounded-full"
                    style={{ background: STATE_COLOR[edge.state] }}
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-neutral-300">
                    {other.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-neutral-500">
                    {REL_TYPE_LABEL[edge.type]}
                  </span>
                  <span
                    className="shrink-0 text-[9px]"
                    style={{ color: TRAJECTORY_META[edge.trajectory].color }}
                    title={TRAJECTORY_META[edge.trajectory].label}
                  >
                    {TRAJECTORY_META[edge.trajectory].glyph}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function EdgeCard({ edge, expanded }: { edge: RelationshipEdge; expanded?: boolean }) {
  const traj = TRAJECTORY_META[edge.trajectory]
  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill color={STATE_COLOR[edge.state]}>{STATE_LABEL[edge.state]}</Pill>
        <Pill color={traj.color}>
          <span className="mr-1 text-[9px]">{traj.glyph}</span>
          {traj.label}
        </Pill>
        <Pill>{REL_TYPE_LABEL[edge.type]}</Pill>
      </div>

      {expanded && (
        <>
          <div className="mt-3.5 space-y-2.5">
            <Meter
              label="Strength of tie"
              value={edge.strength}
              color={STATE_COLOR[edge.state]}
            />
            <Row label="Leverage">{leverageLabel(edge)}</Row>
            <Row label="Exposure">{edge.exposure}</Row>
            <Row label="Since">{edge.since}</Row>
            <Row label="Assessment">{CONFIDENCE_LABEL[edge.confidence]}</Row>
          </div>

          <div className="mt-3.5 rounded border border-white/10 bg-white/[0.03] px-3 py-2.5">
            <p className="text-[10px] uppercase tracking-wider text-neutral-500">
              Last movement · {edge.lastEvent.date}
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-neutral-300">
              {edge.lastEvent.summary}
            </p>
          </div>

          <p
            className="mt-3.5 border-l-2 pl-3 text-[13px] leading-relaxed text-neutral-300"
            style={{ borderColor: STATE_COLOR[edge.state] }}
          >
            {edge.narrative}
          </p>
        </>
      )}
    </div>
  )
}

function Meter({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</span>
        <span className="text-[11px] tabular-nums text-neutral-400">{value}/100</span>
      </div>
      <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full"
          style={{ width: `${value}%`, background: color }}
        />
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-[12px]">
      <span className="w-[74px] shrink-0 text-neutral-500">{label}</span>
      <span className="text-neutral-300">{children}</span>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</dt>
      <dd className="mt-0.5 text-[12px] text-neutral-300">{value}</dd>
    </div>
  )
}

function Pill({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
      style={{
        color: color ?? SURFACE.inkSecondary,
        borderColor: color ? `${color}55` : 'rgba(255,255,255,0.14)',
        background: color ? `${color}14` : 'transparent',
      }}
    >
      {children}
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
      {children}
    </h3>
  )
}

function EmptyState() {
  const total = graph.edges.length
  return (
    <div className="flex h-full flex-col justify-center px-6 py-8">
      <p className="text-[10px] uppercase tracking-[0.14em] text-neutral-500">No selection</p>
      <p className="mt-3 text-[13.5px] leading-relaxed text-neutral-400">
        Select any actor to read its profile, the state of its relationship with Repsol, and
        every connection it holds elsewhere in the network.
      </p>
      <p className="mt-4 text-[12.5px] leading-relaxed text-neutral-500">
        Hovering dims everything more than one hop away, so a single relationship can be read
        out of {total} without losing the surrounding structure.
      </p>
    </div>
  )
}
