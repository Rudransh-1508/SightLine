'use client'

import { useState } from 'react'

import type { ProposalView } from '@/lib/review'
import {
  STATE_COLOR,
  STATE_LABEL,
  TRAJECTORY_META,
  REL_TYPE_LABEL,
  CONFIDENCE_LABEL,
} from '@/lib/palette'
import type { RelState, Trajectory } from '@/lib/types'

interface Props {
  initialProposals: ProposalView[]
}

type Decision = 'approve' | 'reject'

export default function ReviewQueue({ initialProposals }: Props) {
  const [proposals, setProposals] = useState(initialProposals)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function decide(id: string, action: Decision) {
    setBusyId(id)
    setErrors((e) => ({ ...e, [id]: '' }))
    try {
      const res = await fetch(`/api/proposals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Request failed (${res.status})`)
      }
      // Optimistically drop the reviewed item — the server is the source of
      // truth, but re-fetching the whole queue for one decision is wasteful.
      setProposals((p) => p.filter((x) => x.id !== id))
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [id]: err instanceof Error ? err.message : 'Something went wrong',
      }))
    } finally {
      setBusyId(null)
    }
  }

  if (proposals.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-16 text-center">
        <p className="text-[13.5px] text-neutral-400">Nothing waiting for review.</p>
        <p className="mx-auto mt-3 max-w-md text-[12.5px] leading-relaxed text-neutral-500">
          Proposals appear here after an ingestion run extracts a relationship from a source
          document. Nothing enters the graph until it is approved here.
        </p>
        <p className="mt-4 font-mono text-[11px] text-neutral-600">
          pnpm run ingest live &quot;Repsol&quot;
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
      {proposals.map((p) => (
        <ProposalCard
          key={p.id}
          proposal={p}
          busy={busyId === p.id}
          error={errors[p.id]}
          onDecide={decide}
        />
      ))}
    </div>
  )
}

function entityName(ref: { nodeId: string } | { newName: string }): {
  label: string
  isNew: boolean
} {
  return 'nodeId' in ref
    ? { label: ref.nodeId, isNew: false }
    : { label: ref.newName, isNew: true }
}

function ProposalCard({
  proposal,
  busy,
  error,
  onDecide,
}: {
  proposal: ProposalView
  busy: boolean
  error?: string
  onDecide: (id: string, action: Decision) => void
}) {
  const p = proposal.payload
  const source = entityName(p.source)
  const target = entityName(p.target)
  const isUpdate = proposal.kind === 'edge_update'

  return (
    <article className="rounded border border-white/10 bg-white/[0.02]">
      <header className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
          {isUpdate ? 'Update' : 'New relationship'}
        </span>
        {p.type && (
          <span className="text-[11px] text-neutral-400">{REL_TYPE_LABEL[p.type]}</span>
        )}
        <span className="ml-auto text-[10.5px] text-neutral-500">
          {proposal.confidence !== null && p.confidence
            ? CONFIDENCE_LABEL[p.confidence]
            : 'Unrated'}
          {proposal.model ? ` · ${proposal.model}` : ''}
        </span>
      </header>

      <div className="px-4 py-3">
        {/* The relationship itself */}
        <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
          <EntityChip {...source} />
          <span className="text-neutral-500">→</span>
          <EntityChip {...target} />
        </div>

        {/* What changes, shown as before → after for updates */}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[12px]">
          <FieldChange
            label="State"
            before={proposal.currentEdge?.state}
            after={p.state}
            render={(v) => (
              <span style={{ color: STATE_COLOR[v as RelState] }}>
                {STATE_LABEL[v as RelState]}
              </span>
            )}
          />
          <FieldChange
            label="Trajectory"
            before={proposal.currentEdge?.trajectory}
            after={p.trajectory}
            render={(v) => (
              <span style={{ color: TRAJECTORY_META[v as Trajectory].color }}>
                {TRAJECTORY_META[v as Trajectory].glyph}{' '}
                {TRAJECTORY_META[v as Trajectory].label}
              </span>
            )}
          />
          <FieldChange
            label="Strength"
            before={proposal.currentEdge?.strength}
            after={p.strength}
            render={(v) => <span className="tabular-nums text-neutral-300">{v}/100</span>}
          />
        </div>

        {p.exposure && (
          <p className="mt-3 text-[12.5px] text-neutral-400">
            <span className="text-neutral-500">Exposure: </span>
            {p.exposure}
          </p>
        )}

        {/*
          The evidence quote is the whole basis for trusting this proposal —
          it was verified to appear verbatim in the source before staging, and
          anything that failed that check never reaches this queue.
        */}
        {proposal.evidenceQuote && (
          <blockquote className="mt-3 border-l-2 border-white/15 pl-3 text-[12.5px] leading-relaxed text-neutral-300">
            “{proposal.evidenceQuote}”
          </blockquote>
        )}

        {proposal.source && (
          <a
            href={proposal.source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block max-w-full truncate text-[11.5px] text-neutral-500 underline underline-offset-2 transition hover:text-neutral-300"
          >
            {proposal.source.publisher ?? 'Source'}
            {proposal.source.title ? ` — ${proposal.source.title}` : ''}
          </a>
        )}

        {error && (
          <p className="mt-3 rounded border border-[#d03b3b]/30 bg-[#d03b3b]/10 px-2.5 py-1.5 text-[11.5px] text-[#e8846a]">
            {error}
          </p>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-white/10 px-4 py-2.5">
        <button
          onClick={() => onDecide(proposal.id, 'approve')}
          disabled={busy}
          className="rounded border border-[#2a78d6]/40 bg-[#2a78d6]/15 px-3 py-1.5 text-[12px] font-medium text-[#5598e7] transition hover:bg-[#2a78d6]/25 disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Approve'}
        </button>
        <button
          onClick={() => onDecide(proposal.id, 'reject')}
          disabled={busy}
          className="rounded border border-white/10 px-3 py-1.5 text-[12px] text-neutral-400 transition hover:bg-white/[0.05] disabled:opacity-50"
        >
          Reject
        </button>
        <span className="ml-auto text-[10.5px] text-neutral-600">
          Approving writes to the graph and records a revision
        </span>
      </footer>
    </article>
  )
}

function EntityChip({ label, isNew }: { label: string; isNew: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-white/10 bg-white/[0.04] px-2 py-1">
      <span className="text-neutral-200">{label}</span>
      {isNew && (
        <span
          className="rounded bg-[#c98500]/20 px-1 text-[9.5px] uppercase tracking-wide text-[#c98500]"
          title="This actor is not in the graph yet — approving will create it"
        >
          new
        </span>
      )}
    </span>
  )
}

/** Shows `before → after` when updating an existing edge, or just the value when creating. */
function FieldChange({
  label,
  before,
  after,
  render,
}: {
  label: string
  before: string | number | null | undefined
  after: string | number | null | undefined
  render: (v: string | number) => React.ReactNode
}) {
  if (after === null || after === undefined) return null
  const changed = before !== null && before !== undefined && String(before) !== String(after)

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-neutral-500">{label}:</span>
      {changed && (
        <>
          <span className="text-neutral-600 line-through">{render(before)}</span>
          <span className="text-neutral-600">→</span>
        </>
      )}
      {render(after)}
    </span>
  )
}
