import Link from 'next/link'

import ReviewQueue from '@/components/ReviewQueue'
import { requireUser } from '@/lib/auth'
import { listPendingProposals, listSourcedDatasets } from '@/lib/review'

/**
 * The analyst review queue.
 *
 * Server component: verifies the session and loads pending proposals.
 * `requireUser()` is the security boundary — src/proxy.ts only provides the
 * fast redirect (see src/lib/auth.ts).
 */
export default async function ReviewPage() {
  await requireUser()

  const datasets = await listSourcedDatasets()
  // Only sourced datasets can hold proposals at all — the illustrative demo is
  // structurally unproposable (design spec §3.2), enforced by a DB constraint.
  const proposals = datasets.length > 0 ? await listPendingProposals(datasets[0].id) : []

  return (
    <div className="flex h-dvh flex-col bg-[#0b0b0a] text-neutral-200">
      <header className="shrink-0 border-b border-white/10 px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <div className="flex items-baseline gap-3">
            <Link
              href="/"
              className="text-[15px] font-semibold tracking-tight text-neutral-100 transition hover:text-white"
            >
              Sightline
            </Link>
            <span className="text-[12px] text-neutral-400">Review queue</span>
            <span className="text-[11px] text-neutral-500">
              {proposals.length} pending {proposals.length === 1 ? 'proposal' : 'proposals'}
              {datasets.length > 0 ? ` · ${datasets[0].name}` : ''}
            </span>
          </div>
          <Link
            href="/"
            className="text-[11px] text-neutral-400 underline underline-offset-2 transition hover:text-neutral-200"
          >
            ← Back to graph
          </Link>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <ReviewQueue initialProposals={proposals} />
      </main>
    </div>
  )
}
