/**
 * Domain model for the stakeholder relationship graph.
 *
 * Design note: `state` (how a relationship is doing now) and `trajectory`
 * (where it is heading) are deliberately separate axes. A relationship can be
 * hostile-but-improving or cooperative-but-deteriorating, and collapsing them
 * into a single "health" score destroys the most decision-relevant signal.
 */

export type Category =
  | 'client'
  | 'government'
  | 'regulator'
  | 'competitor'
  | 'supplier'
  | 'customer'
  | 'financier'
  | 'union'
  | 'ngo'
  | 'individual'

/** Geographic clusters, used to seed spatial layout so the graph is not a blob. */
export type Region = 'Iberia' | 'North Africa' | 'Latin America' | 'Europe' | 'North America'

/** How the relationship is doing right now. Ordered worst -> best. */
export type RelState = 'hostile' | 'strained' | 'transactional' | 'stable' | 'cooperative'

/** Where the relationship is heading. */
export type Trajectory = 'deteriorating' | 'stable' | 'improving'

export type RelType =
  | 'contractual'
  | 'regulatory'
  | 'equity'
  | 'financing'
  | 'adversarial'
  | 'political'
  | 'advocacy'
  | 'labour'

/**
 * Direction encodes *leverage*, not graph topology. Repsol depends on Sonatrach
 * for gas; the CNMC does not depend on Repsol. Knowing who needs whom is what
 * makes this a risk tool rather than an org chart.
 */
export type Direction = 'mutual' | 'source-depends' | 'target-depends'

export type Confidence = 'high' | 'medium' | 'low'

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
