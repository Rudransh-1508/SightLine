'use client'

import { createContext, useContext, useMemo } from 'react'

import { buildGraphIndex, type GraphIndex } from '@/lib/graph'
import { computeMetrics, type NodeMetrics } from '@/lib/analytics'
import type { GraphData, DatasetKind } from '@/lib/types'

export interface GraphContextValue extends GraphIndex {
  datasetSlug: string
  datasetName: string
  datasetKind: DatasetKind
  /** Structural metrics. Deterministic, free, and computed client-side. */
  metrics: Map<string, NodeMetrics>
  maxBetweenness: number
}

const GraphContext = createContext<GraphContextValue | null>(null)

/**
 * Supplies the active dataset to the whole view.
 *
 * Components previously imported a module-level `graph` built from the JSON
 * file, which hard-wired them to a single dataset and made a database-backed or
 * switchable dataset impossible. They now read from context, so the same
 * components render the illustrative demo and the sourced live graph
 * unchanged — the data source moved, the rendering contract did not.
 */
export function GraphProvider({
  data,
  datasetSlug,
  datasetName,
  datasetKind,
  children,
}: {
  data: GraphData
  datasetSlug: string
  datasetName: string
  datasetKind: DatasetKind
  children: React.ReactNode
}) {
  const value = useMemo<GraphContextValue>(() => {
    // 35 nodes: computing in the browser is instantaneous and avoids shipping a
    // second payload. Recompute if that stops being true at scale.
    const metrics = computeMetrics(data)
    const maxBetweenness = Math.max(
      ...[...metrics.values()].map((m) => m.betweenness),
      Number.EPSILON,
    )
    return {
      ...buildGraphIndex(data),
      datasetSlug,
      datasetName,
      datasetKind,
      metrics,
      maxBetweenness,
    }
  }, [data, datasetSlug, datasetName, datasetKind])
  return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>
}

export function useGraph(): GraphContextValue {
  const ctx = useContext(GraphContext)
  if (!ctx) {
    throw new Error('useGraph must be used inside a <GraphProvider>')
  }
  return ctx
}
