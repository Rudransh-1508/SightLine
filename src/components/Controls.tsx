'use client'

import {
  CATEGORY_STYLE,
  CATEGORY_ORDER,
  STATE_COLOR,
  STATE_ORDER,
  STATE_LABEL,
  TRAJECTORY_ORDER,
  TRAJECTORY_META,
  shapePath,
} from '@/lib/palette'
import type { Category, RelState, Trajectory } from '@/lib/types'

export interface FilterState {
  categories: Set<Category>
  states: Set<RelState>
  trajectories: Set<Trajectory>
  minStrength: number
  query: string
}

interface Props {
  filters: FilterState
  onChange: (f: FilterState) => void
  visibleCount: number
  totalCount: number
}

export default function Controls({ filters, onChange, visibleCount, totalCount }: Props) {
  function toggle<T>(set: Set<T>, value: T, key: keyof FilterState) {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    onChange({ ...filters, [key]: next })
  }

  const dirty =
    filters.categories.size < CATEGORY_ORDER.length ||
    filters.states.size < STATE_ORDER.length ||
    filters.trajectories.size < TRAJECTORY_ORDER.length ||
    filters.minStrength > 0 ||
    filters.query !== ''

  function reset() {
    onChange({
      categories: new Set(CATEGORY_ORDER),
      states: new Set(STATE_ORDER),
      trajectories: new Set(TRAJECTORY_ORDER),
      minStrength: 0,
      query: '',
    })
  }

  /** One-click lens onto the relationships that are getting worse. */
  function riskLens() {
    onChange({
      categories: new Set(CATEGORY_ORDER),
      states: new Set(STATE_ORDER),
      trajectories: new Set<Trajectory>(['deteriorating']),
      minStrength: 45,
      query: '',
    })
  }

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-4 py-4">
      <div>
        <input
          value={filters.query}
          onChange={(e) => onChange({ ...filters, query: e.target.value })}
          placeholder="Search actors…"
          className="w-full rounded border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12.5px] text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-white/25"
        />
      </div>

      <button
        onClick={riskLens}
        className="rounded border border-[#e8846a]/35 bg-[#e8846a]/10 px-3 py-2 text-left text-[12px] font-medium text-[#e8846a] transition hover:bg-[#e8846a]/20"
      >
        ▼ Risk lens
        <span className="mt-0.5 block text-[10.5px] font-normal text-[#e8846a]/70">
          Material relationships that are deteriorating
        </span>
      </button>

      <Group label="Actor type">
        <div className="space-y-0.5">
          {CATEGORY_ORDER.map((c) => {
            const s = CATEGORY_STYLE[c]
            const on = filters.categories.has(c)
            return (
              <button
                key={c}
                onClick={() => toggle(filters.categories, c, 'categories')}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition ${
                  on ? 'text-neutral-200' : 'text-neutral-600'
                } hover:bg-white/[0.05]`}
              >
                <svg width="14" height="14" viewBox="-9 -9 18 18" className="shrink-0">
                  <path
                    d={shapePath(s.shape, 6.5)}
                    fill={on ? s.color : 'transparent'}
                    stroke={s.color}
                    strokeWidth={1.4}
                    opacity={on ? 1 : 0.45}
                  />
                </svg>
                {s.label}
              </button>
            )
          })}
        </div>
      </Group>

      <Group label="Relationship state">
        <div className="space-y-0.5">
          {STATE_ORDER.map((s) => {
            const on = filters.states.has(s)
            return (
              <button
                key={s}
                onClick={() => toggle(filters.states, s, 'states')}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition ${
                  on ? 'text-neutral-200' : 'text-neutral-600'
                } hover:bg-white/[0.05]`}
              >
                <span
                  className="h-[3px] w-5 shrink-0 rounded-full"
                  style={{
                    background: STATE_COLOR[s],
                    opacity: on ? 1 : 0.35,
                    // Adverse states are dashed in the graph; mirror that here.
                    ...(s === 'hostile' || s === 'strained'
                      ? {
                          background: `repeating-linear-gradient(90deg, ${STATE_COLOR[s]} 0 4px, transparent 4px 7px)`,
                        }
                      : {}),
                  }}
                />
                {STATE_LABEL[s]}
              </button>
            )
          })}
        </div>
      </Group>

      <Group label="Trajectory">
        <div className="space-y-0.5">
          {TRAJECTORY_ORDER.map((t) => {
            const m = TRAJECTORY_META[t]
            const on = filters.trajectories.has(t)
            return (
              <button
                key={t}
                onClick={() => toggle(filters.trajectories, t, 'trajectories')}
                className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition ${
                  on ? 'text-neutral-200' : 'text-neutral-600'
                } hover:bg-white/[0.05]`}
              >
                <span
                  className="w-3 shrink-0 text-center text-[9px]"
                  style={{ color: m.color, opacity: on ? 1 : 0.4 }}
                >
                  {m.glyph}
                </span>
                {m.label}
              </button>
            )
          })}
        </div>
      </Group>

      <Group label={`Minimum tie strength · ${filters.minStrength}`}>
        <input
          type="range"
          min={0}
          max={90}
          step={5}
          value={filters.minStrength}
          onChange={(e) => onChange({ ...filters, minStrength: Number(e.target.value) })}
          className="mt-1 w-full accent-neutral-400"
        />
      </Group>

      <div className="mt-auto space-y-2 border-t border-white/10 pt-3">
        <p className="text-[11px] text-neutral-500">
          Showing <span className="text-neutral-300 tabular-nums">{visibleCount}</span> of{' '}
          <span className="tabular-nums">{totalCount}</span> relationships
        </p>
        {dirty && (
          <button
            onClick={reset}
            className="text-[11px] text-neutral-400 underline underline-offset-2 transition hover:text-neutral-200"
          >
            Clear all filters
          </button>
        )}
      </div>
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-neutral-500">
        {label}
      </h3>
      {children}
    </div>
  )
}
