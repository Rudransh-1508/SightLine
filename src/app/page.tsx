import { notFound } from 'next/navigation'

import GraphView from '@/components/GraphView'
import { GraphProvider } from '@/components/GraphProvider'
import { requireUser } from '@/lib/auth'
import { getGraph } from '@/lib/graph-db'

/**
 * Server component: verifies the session and loads the dataset.
 *
 * `requireUser()` is the security boundary — src/proxy.ts only provides the
 * fast redirect, and Next's own docs say proxy must not be relied on for
 * authorization. Removing the proxy would change the sign-in experience but
 * would not expose this page's data.
 */
export default async function Page() {
  const user = await requireUser()

  const graph = await getGraph('repsol-demo')
  if (!graph) notFound()

  return (
    <GraphProvider
      data={graph}
      datasetSlug={graph.slug}
      datasetName={graph.name}
      datasetKind={graph.kind}
    >
      {/* The cached balance is good enough to render; the copilot replaces it
          with the ledger-derived figure after every answer. */}
      <GraphView initialCredits={user.creditBalance} />
    </GraphProvider>
  )
}
