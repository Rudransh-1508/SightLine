import { describe, it, expect } from 'vitest'
import {
  CATEGORY_STYLE,
  CATEGORY_ORDER,
  STATE_COLOR,
  STATE_ORDER,
  STATE_LABEL,
  TRAJECTORY_ORDER,
  TRAJECTORY_META,
  REGION_ANCHOR,
  shapePath,
  stateDash,
} from '../palette'
import { graph } from '../graph'
import type { Category } from '../types'

describe('category encoding', () => {
  it('styles every category used in the data', () => {
    for (const n of graph.nodes) {
      expect(CATEGORY_STYLE[n.category]).toBeDefined()
    }
  })

  it('lists every category except the client in the filter order', () => {
    const all = Object.keys(CATEGORY_STYLE).filter((c) => c !== 'client')
    expect([...CATEGORY_ORDER].sort()).toEqual(all.sort())
  })

  /**
   * The whole point of the shape-family design: colour only has to separate
   * categories that share a shape, so no two categories may collide on both.
   */
  it('never gives two categories the same shape AND colour', () => {
    const seen = new Set<string>()
    for (const [cat, s] of Object.entries(CATEGORY_STYLE)) {
      const key = `${s.shape}|${s.color}`
      expect(seen.has(key), `${cat} duplicates ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('keeps colours distinct within every shape family', () => {
    const byShape = new Map<string, string[]>()
    for (const s of Object.values(CATEGORY_STYLE)) {
      byShape.set(s.shape, [...(byShape.get(s.shape) ?? []), s.color])
    }
    for (const [shape, colors] of byShape) {
      expect(new Set(colors).size, `${shape} has repeated colours`).toBe(colors.length)
    }
  })

  it('caps any shape family at three colours, the validated all-pairs limit', () => {
    const counts = new Map<string, number>()
    for (const s of Object.values(CATEGORY_STYLE)) {
      counts.set(s.shape, (counts.get(s.shape) ?? 0) + 1)
    }
    for (const [shape, n] of counts) {
      expect(n, `${shape} family is too large to stay CVD-separable`).toBeLessThanOrEqual(3)
    }
  })

  it('gives the client its own distinct shape', () => {
    const clientShape = CATEGORY_STYLE.client.shape
    const others = Object.entries(CATEGORY_STYLE)
      .filter(([c]) => c !== 'client')
      .map(([, s]) => s.shape)
    expect(others).not.toContain(clientShape)
  })

  it('uses valid hex colours throughout', () => {
    for (const s of Object.values(CATEGORY_STYLE)) {
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('relationship state encoding', () => {
  it('orders states worst to best', () => {
    expect(STATE_ORDER).toEqual([
      'hostile',
      'strained',
      'transactional',
      'stable',
      'cooperative',
    ])
  })

  it('colours and labels every state', () => {
    for (const s of STATE_ORDER) {
      expect(STATE_COLOR[s]).toMatch(/^#[0-9a-f]{6}$/i)
      expect(STATE_LABEL[s]).toBeTruthy()
    }
  })

  it('gives every state a distinct colour', () => {
    const colors = STATE_ORDER.map((s) => STATE_COLOR[s])
    expect(new Set(colors).size).toBe(colors.length)
  })

  /**
   * Polarity must survive colour-blindness, so the adverse arm carries a dash
   * pattern as a redundant channel and the constructive arm must not.
   */
  it('dashes only the adverse states', () => {
    expect(stateDash('hostile')).toBeTruthy()
    expect(stateDash('strained')).toBeTruthy()
    expect(stateDash('transactional')).toBeUndefined()
    expect(stateDash('stable')).toBeUndefined()
    expect(stateDash('cooperative')).toBeUndefined()
  })
})

describe('trajectory encoding', () => {
  it('covers all three trajectories with a glyph, label and colour', () => {
    expect(TRAJECTORY_ORDER).toHaveLength(3)
    for (const t of TRAJECTORY_ORDER) {
      const m = TRAJECTORY_META[t]
      expect(m.glyph).toBeTruthy()
      expect(m.label).toBeTruthy()
      expect(m.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('uses a distinct glyph per trajectory, so meaning never rests on colour', () => {
    const glyphs = TRAJECTORY_ORDER.map((t) => TRAJECTORY_META[t].glyph)
    expect(new Set(glyphs).size).toBe(glyphs.length)
  })
})

describe('region anchors', () => {
  it('anchors every region present in the data', () => {
    for (const n of graph.nodes) {
      expect(REGION_ANCHOR[n.region], `no anchor for ${n.region}`).toBeDefined()
    }
  })

  it('places every anchor inside the viewport', () => {
    for (const a of Object.values(REGION_ANCHOR)) {
      expect(a.x).toBeGreaterThan(0)
      expect(a.x).toBeLessThan(1)
      expect(a.y).toBeGreaterThan(0)
      expect(a.y).toBeLessThan(1)
    }
  })

  it('separates the anchors, otherwise clustering does nothing', () => {
    const pts = Object.values(REGION_ANCHOR)
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y)
        expect(d).toBeGreaterThan(0.15)
      }
    }
  })
})

describe('shapePath', () => {
  const shapes = ['ring', 'square', 'circle', 'hexagon', 'triangle', 'diamond'] as const

  it.each(shapes)('emits a closed path for %s', (shape) => {
    const d = shapePath(shape, 10)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect(d).not.toMatch(/NaN|Infinity/)
  })

  it('scales with radius', () => {
    expect(shapePath('square', 10)).not.toBe(shapePath('square', 20))
  })

  it('handles a zero radius without producing NaN', () => {
    for (const s of shapes) {
      expect(shapePath(s, 0)).not.toMatch(/NaN/)
    }
  })
})

describe('every category in the data resolves to a renderable style', () => {
  it.each([...new Set(graph.nodes.map((n) => n.category))])('%s', (cat) => {
    const s = CATEGORY_STYLE[cat as Category]
    expect(shapePath(s.shape, 12)).toMatch(/^M/)
  })
})
