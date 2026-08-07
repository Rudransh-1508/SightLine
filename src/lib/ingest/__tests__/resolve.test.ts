import { describe, it, expect } from 'vitest'

import { resolveEntity } from '../resolve'
import type { EntityIndexEntry } from '../prefilter'

const INDEX: EntityIndexEntry[] = [
  { nodeId: 'sonatrach', matchers: ['Sonatrach', 'Sonatrach SPA', 'SH'] },
  { nodeId: 'repsol', matchers: ['Repsol'] },
  { nodeId: 'repsol-sinopec', matchers: ['Repsol Sinopec'] },
]

describe('resolveEntity — exact matches', () => {
  it('resolves the canonical name', () => {
    expect(resolveEntity('Repsol', INDEX)).toEqual({
      kind: 'existing',
      nodeId: 'repsol',
      matchType: 'exact',
    })
  })

  it('resolves an alias', () => {
    expect(resolveEntity('Sonatrach SPA', INDEX)).toEqual({
      kind: 'existing',
      nodeId: 'sonatrach',
      matchType: 'exact',
    })
  })

  it('resolves a short alias exactly', () => {
    expect(resolveEntity('SH', INDEX)).toEqual({
      kind: 'existing',
      nodeId: 'sonatrach',
      matchType: 'exact',
    })
  })

  it('is case-insensitive', () => {
    expect(resolveEntity('REPSOL', INDEX).kind).toBe('existing')
  })

  it('ignores punctuation differences', () => {
    expect(resolveEntity('Repsol,', INDEX)).toMatchObject({ nodeId: 'repsol' })
  })

  /**
   * This is the case the design spec calls out explicitly: "Repsol" and
   * "Repsol Sinopec" are different entities and must resolve to different
   * nodes, not collapse into one because they share a prefix.
   */
  it('does not confuse a name with a superset name that is itself tracked', () => {
    expect(resolveEntity('Repsol Sinopec', INDEX)).toMatchObject({ nodeId: 'repsol-sinopec' })
    expect(resolveEntity('Repsol', INDEX)).toMatchObject({ nodeId: 'repsol' })
  })
})

describe('resolveEntity — fuzzy matches', () => {
  it('resolves a small typo in a longer name', () => {
    const result = resolveEntity('Sonatrch', INDEX) // missing an 'a'
    expect(result).toMatchObject({ kind: 'existing', nodeId: 'sonatrach', matchType: 'fuzzy' })
  })

  it('does not fuzzy-match a short alias', () => {
    // "SG" is one edit from "SH" but short aliases require an exact hit —
    // otherwise a 2-character alias would match almost anything nearby.
    const result = resolveEntity('SG', INDEX)
    expect(result.kind).toBe('new')
  })

  it('does not fuzzy-match two genuinely different names', () => {
    expect(resolveEntity('ExxonMobil', INDEX).kind).toBe('new')
  })

  it('prefers an exact match elsewhere over a fuzzy match', () => {
    // "Repsol" is a valid exact match on its own; it should never fuzzy-drift
    // toward "Repsol Sinopec" just because that's also close.
    expect(resolveEntity('Repsol', INDEX)).toMatchObject({
      nodeId: 'repsol',
      matchType: 'exact',
    })
  })
})

describe('resolveEntity — unresolved', () => {
  it('proposes a new entity for something not in the index', () => {
    expect(resolveEntity('TotalEnergies', INDEX)).toEqual({
      kind: 'new',
      proposedName: 'TotalEnergies',
    })
  })

  it('handles an empty index', () => {
    expect(resolveEntity('Anything', []).kind).toBe('new')
  })

  it('handles a blank extracted name', () => {
    expect(resolveEntity('', INDEX).kind).toBe('new')
  })
})
