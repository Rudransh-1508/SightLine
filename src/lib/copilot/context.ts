import { computeMetrics } from '@/lib/analytics'
import { getGraph, edgeRevisions } from '@/lib/graph-db'
import type { CopilotContext } from './tools'

/**
 * Loads one dataset and prepares it for the copilot.
 *
 * The whole graph is read in one go rather than per tool call: 35 nodes and 54
 * edges is small, tool calls within a question repeatedly touch the same data,
 * and a per-call round trip would make each turn slower for no benefit. If a
 * dataset ever grows past the point where that holds, this is the seam to
 * change — the tools themselves never touch the database.
 *
 * Metrics are computed here for the same reason, and are free: deterministic
 * graph algorithms, never a model call (CLAUDE.md).
 */
export interface ClientIdentity {
  id: string
  name: string
}

export async function buildCopilotContext(slug: string): Promise<{
  context: CopilotContext
  datasetName: string
  /** The graph's own client node — "me" in a question, per agent.ts. */
  client: ClientIdentity
} | null> {
  const graph = await getGraph(slug)
  if (!graph) return null

  const clientNode = graph.nodes.find((n) => n.id === graph.client)

  return {
    datasetName: graph.name,
    // graph.client is always one of graph.nodes (graph-db.ts derives it from
    // the same rows), so this is defensive, not an expected fallback.
    client: { id: graph.client, name: clientNode?.name ?? graph.client },
    context: {
      graph,
      metrics: computeMetrics(graph),
      timeline: (source, target, type) => edgeRevisions(slug, source, target, type),
    },
  }
}
