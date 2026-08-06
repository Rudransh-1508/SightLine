import { config } from 'dotenv'
config({ path: ['.env.local', '.env'] })

import { eq } from 'drizzle-orm'

import { db } from './client'
import { datasets, nodes, edges } from './schema'
import raw from '@/data/stakeholders.json'
import type { GraphData } from '@/lib/types'

const graph = raw as unknown as GraphData

export const DEMO_DATASET = 'repsol-demo'
export const LIVE_DATASET = 'live'

/**
 * Seeds the two datasets.
 *
 * `repsol-demo` is loaded from src/data/stakeholders.json, which remains the
 * source of truth for the illustrative graph — that is what keeps the existing
 * data-integrity tests meaningful and the seed reproducible.
 *
 * Idempotent: re-running replaces the demo dataset's contents rather than
 * duplicating them. The `live` dataset is only ever created, never cleared,
 * because its contents are approved proposals that must not be destroyed by a
 * routine seed.
 */
export async function seed(): Promise<{ nodes: number; edges: number }> {
  await db
    .insert(datasets)
    .values({
      id: DEMO_DATASET,
      slug: DEMO_DATASET,
      name: 'Repsol (illustrative)',
      kind: 'illustrative',
      description:
        'Hand-authored demonstration graph. Organisation and individual names are ' +
        'real, but every relationship state, score, event and assessment is invented.',
    })
    .onConflictDoNothing()

  await db
    .insert(datasets)
    .values({
      id: LIVE_DATASET,
      slug: LIVE_DATASET,
      name: 'Live (sourced)',
      kind: 'sourced',
      description:
        'Built only from approved, evidence-backed proposals extracted from real sources.',
    })
    .onConflictDoNothing()

  // Replace demo contents wholesale. Edges cascade from nodes, but delete them
  // explicitly so the intent is visible rather than relying on cascade order.
  await db.delete(edges).where(eq(edges.datasetId, DEMO_DATASET))
  await db.delete(nodes).where(eq(nodes.datasetId, DEMO_DATASET))

  await db.insert(nodes).values(
    graph.nodes.map((n) => ({
      id: n.id,
      datasetId: DEMO_DATASET,
      name: n.name,
      category: n.category,
      country: n.country,
      region: n.region,
      influence: n.influence,
      role: n.role,
      description: n.description,
      keyPeople: n.keyPeople ?? [],
    })),
  )

  await db.insert(edges).values(
    graph.edges.map((e) => ({
      // Deterministic id: re-seeding yields the same rows, so revisions and
      // metrics that reference an edge survive a reseed.
      id: `${DEMO_DATASET}:${e.source}->${e.target}:${e.type}`,
      datasetId: DEMO_DATASET,
      sourceId: e.source,
      targetId: e.target,
      type: e.type,
      direction: e.direction,
      strength: e.strength,
      state: e.state,
      trajectory: e.trajectory,
      exposure: e.exposure,
      since: e.since,
      lastEventDate: e.lastEvent.date,
      lastEventSummary: e.lastEvent.summary,
      narrative: e.narrative,
      confidence: e.confidence,
    })),
  )

  return { nodes: graph.nodes.length, edges: graph.edges.length }
}

// Run directly via `pnpm run db:seed`.
if (process.argv[1]?.includes('seed')) {
  seed()
    .then((counts) => {
      console.log(`seeded ${DEMO_DATASET}: ${counts.nodes} nodes, ${counts.edges} edges`)
      console.log(`ensured ${LIVE_DATASET} dataset exists (empty)`)
      process.exit(0)
    })
    .catch((err) => {
      console.error('seed failed:', err)
      process.exit(1)
    })
}
