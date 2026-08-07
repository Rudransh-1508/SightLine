import type { Category, RelState, Trajectory, RelType, Confidence } from './types'

/**
 * Visual encoding.
 *
 * Category is carried by SHAPE FIRST, colour second. Ten categories is far more
 * than any categorical palette can separate for colour-vision-deficient readers
 * — validated all-pairs, the eight-hue set fails (magenta/aqua ΔE 1.6 deutan,
 * red/orange ΔE 7.1 normal). Splitting the categories into shape families and
 * validating the colours *within each family* fixes it: every family below
 * passes all-pairs CVD and normal-vision floors on the dark surface, and the
 * pairs that fail across families are never the same shape.
 *
 * Palette values are the dark-mode steps of the reference categorical palette.
 */

export const SURFACE = {
  page: '#0b0b0a',
  panel: '#12120f',
  raised: '#1a1a17',
  hairline: 'rgba(255,255,255,0.09)',
  ink: '#f4f3ee',
  inkSecondary: '#c3c2b7',
  inkMuted: '#898781',
} as const

export type Shape = 'ring' | 'square' | 'circle' | 'hexagon' | 'triangle' | 'diamond'

interface CategoryStyle {
  color: string
  shape: Shape
  /** Shape family — colours are validated for separation within a family. */
  family: string
  label: string
}

export const CATEGORY_STYLE: Record<Category, CategoryStyle> = {
  client: { color: '#ffffff', shape: 'ring', family: 'Client', label: 'Client' },
  government: { color: '#3987e5', shape: 'square', family: 'State', label: 'Government' },
  regulator: { color: '#d95926', shape: 'square', family: 'State', label: 'Regulator' },
  supplier: {
    color: '#199e70',
    shape: 'circle',
    family: 'Commercial',
    label: 'Supplier / partner',
  },
  competitor: { color: '#c98500', shape: 'circle', family: 'Commercial', label: 'Competitor' },
  customer: { color: '#9085e9', shape: 'circle', family: 'Commercial', label: 'Customer' },
  financier: { color: '#e66767', shape: 'hexagon', family: 'Capital', label: 'Financier' },
  ngo: { color: '#d55181', shape: 'triangle', family: 'Civil society', label: 'NGO' },
  union: { color: '#008300', shape: 'triangle', family: 'Civil society', label: 'Union' },
  individual: { color: '#898781', shape: 'diamond', family: 'Individual', label: 'Individual' },
}

export const CATEGORY_ORDER: Category[] = [
  'government',
  'regulator',
  'supplier',
  'competitor',
  'customer',
  'financier',
  'ngo',
  'union',
  'individual',
]

/**
 * Relationship state is a DIVERGING scale: a red arm (adverse), a neutral grey
 * midpoint, and a blue arm (constructive). Red↔blue rather than red↔green
 * because red/green is the one pair colour-vision-deficient readers cannot
 * separate — and the adverse arm is additionally dashed, so polarity never
 * rests on hue alone.
 */
export const STATE_COLOR: Record<RelState, string> = {
  hostile: '#d03b3b',
  strained: '#e8846a',
  transactional: '#8a877f',
  stable: '#5598e7',
  cooperative: '#2a78d6',
}

/** Worst -> best. Drives legend order and the state filter. */
export const STATE_ORDER: RelState[] = [
  'hostile',
  'strained',
  'transactional',
  'stable',
  'cooperative',
]

export const STATE_LABEL: Record<RelState, string> = {
  hostile: 'Hostile',
  strained: 'Strained',
  transactional: 'Transactional',
  stable: 'Stable',
  cooperative: 'Cooperative',
}

/** Redundant, non-colour encoding of the adverse arm. */
export function stateDash(state: RelState): string | undefined {
  if (state === 'hostile') return '2 3'
  if (state === 'strained') return '6 4'
  return undefined
}

export const TRAJECTORY_ORDER: Trajectory[] = ['deteriorating', 'stable', 'improving']

export const TRAJECTORY_META: Record<
  Trajectory,
  { glyph: string; label: string; color: string }
> = {
  deteriorating: { glyph: '▼', label: 'Deteriorating', color: '#e8846a' },
  stable: { glyph: '■', label: 'Holding', color: '#8a877f' },
  improving: { glyph: '▲', label: 'Improving', color: '#5598e7' },
}

export const REL_TYPE_LABEL: Record<RelType, string> = {
  contractual: 'Contractual',
  regulatory: 'Regulatory',
  equity: 'Equity / JV',
  financing: 'Financing',
  adversarial: 'Adversarial',
  political: 'Political',
  advocacy: 'Advocacy',
  labour: 'Labour',
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
}

/** Region anchors as fractions of the viewport, used to seed spatial clustering. */
export const REGION_ANCHOR: Record<string, { x: number; y: number }> = {
  Iberia: { x: 0.5, y: 0.48 },
  Europe: { x: 0.72, y: 0.2 },
  'North America': { x: 0.82, y: 0.68 },
  'North Africa': { x: 0.34, y: 0.82 },
  'Latin America': { x: 0.16, y: 0.36 },
}

/** SVG path for a node glyph of a given shape, centred on the origin. */
export function shapePath(shape: Shape, r: number): string {
  switch (shape) {
    case 'square': {
      const s = r * 0.88
      return `M${-s},${-s}H${s}V${s}H${-s}Z`
    }
    case 'diamond':
      return `M0,${-r}L${r},0L0,${r}L${-r},0Z`
    case 'triangle': {
      const h = r * 1.15
      return `M0,${-h}L${h * 0.92},${h * 0.72}L${-h * 0.92},${h * 0.72}Z`
    }
    case 'hexagon': {
      const pts: string[] = []
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2
        pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`)
      }
      return `M${pts.join('L')}Z`
    }
    default:
      return `M${-r},0A${r},${r} 0 1,0 ${r},0A${r},${r} 0 1,0 ${-r},0Z`
  }
}

/**
 * Colours for discovered communities.
 *
 * Reuses the validated dark-mode categorical steps. Community colouring and
 * category colouring are mutually exclusive views, so the two never appear at
 * once and cannot be confused. Louvain community ids are small integers; more
 * communities than colours wraps, which is acceptable because community
 * identity is relative and the legend is positional.
 */
export const COMMUNITY_COLORS = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#9085e9',
  '#008300',
  '#d55181',
  '#e66767',
] as const

export function communityColor(id: number): string {
  return COMMUNITY_COLORS[id % COMMUNITY_COLORS.length]
}
