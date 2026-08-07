import {
  pgEnum,
  pgTable,
  text,
  integer,
  timestamp,
  jsonb,
  doublePrecision,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
  unique,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

import {
  CATEGORIES,
  REGIONS,
  REL_STATES,
  TRAJECTORIES,
  REL_TYPES,
  DIRECTIONS,
  CONFIDENCES,
  DATASET_KINDS,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
} from '@/lib/types'

/*
 * Enums are generated from the unions in src/lib/types.ts. Adding a value there
 * and forgetting it here is impossible — there is only one list.
 */
export const categoryEnum = pgEnum('category', CATEGORIES)
export const regionEnum = pgEnum('region', REGIONS)
export const relStateEnum = pgEnum('rel_state', REL_STATES)
export const trajectoryEnum = pgEnum('trajectory', TRAJECTORIES)
export const relTypeEnum = pgEnum('rel_type', REL_TYPES)
export const directionEnum = pgEnum('direction', DIRECTIONS)
export const confidenceEnum = pgEnum('confidence', CONFIDENCES)
export const datasetKindEnum = pgEnum('dataset_kind', DATASET_KINDS)
export const proposalKindEnum = pgEnum('proposal_kind', PROPOSAL_KINDS)
export const proposalStatusEnum = pgEnum('proposal_status', PROPOSAL_STATUSES)

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export const datasets = pgTable(
  'datasets',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    kind: datasetKindEnum('kind').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('datasets_slug_key').on(t.slug),
    /*
     * Redundant on its own — id is already the primary key — but a composite
     * FOREIGN KEY must reference a UNIQUE constraint covering exactly its
     * columns. This is what lets `proposals` reference (id, kind) and thereby
     * be structurally incapable of targeting an illustrative dataset.
     */
    unique('datasets_id_kind_key').on(t.id, t.kind),
  ],
)

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export const nodes = pgTable(
  'nodes',
  {
    id: text('id').notNull(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: categoryEnum('category').notNull(),
    country: text('country').notNull(),
    region: regionEnum('region').notNull(),
    influence: integer('influence').notNull(),
    role: text('role').notNull(),
    description: text('description').notNull(),
    keyPeople: jsonb('key_people').$type<string[]>().notNull().default([]),
  },
  (t) => [
    // Node ids are only unique within a dataset: the same real-world actor may
    // exist in both the demo and the live graph as separate rows.
    primaryKey({ columns: [t.datasetId, t.id] }),
    index('nodes_dataset_idx').on(t.datasetId),
    check('nodes_influence_range', sql`${t.influence} between 0 and 100`),
  ],
)

export const edges = pgTable(
  'edges',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    targetId: text('target_id').notNull(),
    type: relTypeEnum('type').notNull(),
    direction: directionEnum('direction').notNull(),
    strength: integer('strength').notNull(),
    state: relStateEnum('state').notNull(),
    trajectory: trajectoryEnum('trajectory').notNull(),
    exposure: text('exposure').notNull(),
    since: integer('since').notNull(),
    lastEventDate: text('last_event_date').notNull(),
    lastEventSummary: text('last_event_summary').notNull(),
    narrative: text('narrative').notNull(),
    confidence: confidenceEnum('confidence').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.datasetId, t.sourceId],
      foreignColumns: [nodes.datasetId, nodes.id],
      name: 'edges_source_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.datasetId, t.targetId],
      foreignColumns: [nodes.datasetId, nodes.id],
      name: 'edges_target_fk',
    }).onDelete('cascade'),
    index('edges_dataset_idx').on(t.datasetId),
    index('edges_source_idx').on(t.datasetId, t.sourceId),
    index('edges_target_idx').on(t.datasetId, t.targetId),
    check('edges_strength_range', sql`${t.strength} between 0 and 100`),
    check('edges_no_self_loop', sql`${t.sourceId} <> ${t.targetId}`),
    /*
     * A pair may hold several relationships (Repsol and TotalEnergies are both
     * consortium partners and competitors) but not two of the same type.
     * Mirrors the "no duplicate edges" data test.
     */
    uniqueIndex('edges_unique_rel').on(t.datasetId, t.sourceId, t.targetId, t.type),
  ],
)

/**
 * Alternative names for a node — "Sonatrach SPA", "the Algerian state oil
 * company", "SH" all resolve to the same node. Two consumers:
 *
 * 1. The deterministic ingestion prefilter (src/lib/ingest/prefilter.ts) scans
 *    fetched text for any node name or alias to decide whether a document is
 *    worth an LLM call at all — zero cost, zero credits.
 * 2. Entity resolution (stage 4 of the pipeline) maps an extracted name string
 *    to an existing node id before proposing a new one.
 *
 * A node's own `name` is always implicitly an alias of itself; this table only
 * holds the *additional* ones.
 */
export const entityAliases = pgTable(
  'entity_aliases',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    nodeId: text('node_id').notNull(),
    alias: text('alias').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.datasetId, t.nodeId],
      foreignColumns: [nodes.datasetId, nodes.id],
      name: 'entity_aliases_node_fk',
    }).onDelete('cascade'),
    uniqueIndex('entity_aliases_unique').on(t.datasetId, t.alias),
    index('entity_aliases_dataset_idx').on(t.datasetId),
  ],
)

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const sources = pgTable(
  'sources',
  {
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    title: text('title'),
    publisher: text('publisher'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    // Dedupe on content, not URL: the same story appears at many URLs.
    contentHash: text('content_hash').notNull(),
  },
  (t) => [uniqueIndex('sources_content_hash_key').on(t.contentHash)],
)

export const proposals = pgTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    /*
     * Denormalised copy of the target dataset's kind, pinned to 'sourced' by a
     * CHECK and tied to the real dataset by the composite FK below.
     *
     * Together these make it *structurally impossible* to stage a proposal
     * against the illustrative demo dataset: the insert fails in Postgres with
     * a foreign-key violation, with no application code involved. A plain CHECK
     * cannot reference another table, and a trigger would hide the rule.
     */
    datasetKind: datasetKindEnum('dataset_kind').notNull().default('sourced'),
    kind: proposalKindEnum('kind').notNull(),
    targetRef: text('target_ref'),
    payload: jsonb('payload').notNull(),
    evidenceQuote: text('evidence_quote'),
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'set null' }),
    confidence: doublePrecision('confidence'),
    model: text('model'),
    status: proposalStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewerNote: text('reviewer_note'),
  },
  (t) => [
    check('proposals_sourced_only', sql`${t.datasetKind} = 'sourced'`),
    foreignKey({
      columns: [t.datasetId, t.datasetKind],
      foreignColumns: [datasets.id, datasets.kind],
      name: 'proposals_dataset_fk',
    }).onDelete('cascade'),
    index('proposals_status_idx').on(t.status, t.createdAt),
  ],
)

export const revisions = pgTable(
  'revisions',
  {
    id: text('id').primaryKey(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    proposalId: text('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('revisions_entity_idx').on(t.entityType, t.entityId, t.appliedAt)],
)

// ---------------------------------------------------------------------------
// Analytics cache
// ---------------------------------------------------------------------------

export const nodeMetrics = pgTable(
  'node_metrics',
  {
    datasetId: text('dataset_id').notNull(),
    nodeId: text('node_id').notNull(),
    betweenness: doublePrecision('betweenness'),
    degree: integer('degree'),
    eigenvector: doublePrecision('eigenvector'),
    communityId: integer('community_id'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.datasetId, t.nodeId] }),
    foreignKey({
      columns: [t.datasetId, t.nodeId],
      foreignColumns: [nodes.datasetId, nodes.id],
      name: 'node_metrics_node_fk',
    }).onDelete('cascade'),
  ],
)

// ---------------------------------------------------------------------------
// Users and credits
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    workosUserId: text('workos_user_id').notNull(),
    email: text('email').notNull(),
    // Derived cache of credit_ledger. Never authoritatively overwritten.
    creditBalance: integer('credit_balance').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_workos_id_key').on(t.workosUserId)],
)

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Negative to spend, positive to grant or refund. Append-only.
    delta: integer('delta').notNull(),
    feature: text('feature').notNull(),
    refId: text('ref_id'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('credit_ledger_user_idx').on(t.userId, t.createdAt)],
)
