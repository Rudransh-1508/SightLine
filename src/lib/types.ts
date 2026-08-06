/**
 * Domain model for the stakeholder relationship graph.
 *
 * Design note: `state` (how a relationship is doing now) and `trajectory`
 * (where it is heading) are deliberately separate axes. A relationship can be
 * hostile-but-improving or cooperative-but-deteriorating, and collapsing them
 * into a single "health" score destroys the most decision-relevant signal.
 */

/*
 * Each union below is declared as a `const` array with the type derived from it.
 * The types are identical to hand-written unions, but the values also exist at
 * runtime — which is what lets the database enums (src/db/schema.ts) and the
 * validation tests be generated from this file rather than duplicating the
 * literals. One source of truth; the DB and the TypeScript model cannot drift.
 */

export const CATEGORIES = [
  'client',
  'government',
  'regulator',
  'competitor',
  'supplier',
  'customer',
  'financier',
  'union',
  'ngo',
  'individual',
] as const
export type Category = (typeof CATEGORIES)[number]

/** Geographic clusters, used to seed spatial layout so the graph is not a blob. */
export const REGIONS = [
  'Iberia',
  'North Africa',
  'Latin America',
  'Europe',
  'North America',
] as const
export type Region = (typeof REGIONS)[number]

/** How the relationship is doing right now. Ordered worst -> best. */
export const REL_STATES = [
  'hostile',
  'strained',
  'transactional',
  'stable',
  'cooperative',
] as const
export type RelState = (typeof REL_STATES)[number]

/** Where the relationship is heading. */
export const TRAJECTORIES = ['deteriorating', 'stable', 'improving'] as const
export type Trajectory = (typeof TRAJECTORIES)[number]

export const REL_TYPES = [
  'contractual',
  'regulatory',
  'equity',
  'financing',
  'adversarial',
  'political',
  'advocacy',
  'labour',
] as const
export type RelType = (typeof REL_TYPES)[number]

/**
 * Direction encodes *leverage*, not graph topology. Repsol depends on Sonatrach
 * for gas; the CNMC does not depend on Repsol. Knowing who needs whom is what
 * makes this a risk tool rather than an org chart.
 */
export const DIRECTIONS = ['mutual', 'source-depends', 'target-depends'] as const
export type Direction = (typeof DIRECTIONS)[number]

export const CONFIDENCES = ['high', 'medium', 'low'] as const
export type Confidence = (typeof CONFIDENCES)[number]

/** Datasets are either the curated illustrative demo or a sourced, ingested set. */
export const DATASET_KINDS = ['illustrative', 'sourced'] as const
export type DatasetKind = (typeof DATASET_KINDS)[number]

export const PROPOSAL_KINDS = ['node_create', 'edge_create', 'edge_update'] as const
export type ProposalKind = (typeof PROPOSAL_KINDS)[number]

export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'auto_rejected'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

export interface StakeholderNode {
  id: string
  name: string
  category: Category
  country: string
  region: Region
  /** 0-100. Drives node radius. Material influence over the client's position. */
  influence: number
  /** One line: what this actor is. */
  role: string
  /** 2-3 sentences for the detail sidebar. */
  description: string
  keyPeople?: string[]
}

export interface RelationshipEdge {
  source: string
  target: string
  type: RelType
  direction: Direction
  /** 0-100. Drives link width. How much of the client's position rides on it. */
  strength: number
  state: RelState
  trajectory: Trajectory
  /** What is materially at stake, in concrete terms. */
  exposure: string
  /** Year the relationship in its current form began. */
  since: number
  lastEvent: { date: string; summary: string }
  /** The analyst's read on the relationship. */
  narrative: string
  confidence: Confidence
}

export interface GraphData {
  client: string
  asOf: string
  nodes: StakeholderNode[]
  edges: RelationshipEdge[]
}

/** Node with the mutable fields d3-force writes onto it during simulation. */
export interface SimNode extends StakeholderNode {
  x?: number
  y?: number
  vx?: number
  vy?: number
  fx?: number | null
  fy?: number | null
}

/** Edge after d3 has resolved the string ids into node object references. */
export interface SimEdge extends Omit<RelationshipEdge, 'source' | 'target'> {
  source: SimNode
  target: SimNode
}
