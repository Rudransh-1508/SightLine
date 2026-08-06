import type { EntityIndexEntry } from './prefilter'

/**
 * Entity resolution — design spec §4's "stage 4", and the hard part. "Sonatrach",
 * "Sonatrach SPA" and "SH" must resolve to one node; "Repsol" and "Repsol
 * Sinopec" must not resolve to each other. Get this wrong and duplicate
 * entities accumulate until the graph is worthless.
 */

export type ResolvedEntity =
  | { kind: 'existing'; nodeId: string; matchType: 'exact' | 'fuzzy' }
  | { kind: 'new'; proposedName: string }

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '') // strip punctuation, keep letters/digits/space
    .replace(/\s+/g, ' ')
    .trim()
}

/** Standard edit distance — small, pure, no reason to add a dependency for it. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      curr[j] =
        a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1])
    }
    prev = curr
  }
  return prev[n]
}

/**
 * Fuzzy match tolerance scales with name length: a typo in a long name should
 * still match, but a short alias like "SH" must require an exact hit or it
 * would swallow half the alphabet. Capped at 3 edits regardless of length so
 * two genuinely different long names never collapse into one.
 */
function fuzzyThreshold(len: number): number {
  return Math.min(3, Math.max(1, Math.floor(len * 0.2)))
}

export function resolveEntity(
  extractedName: string,
  index: EntityIndexEntry[],
): ResolvedEntity {
  const target = normalise(extractedName)
  if (!target) return { kind: 'new', proposedName: extractedName }

  for (const entry of index) {
    for (const matcher of entry.matchers) {
      if (normalise(matcher) === target) {
        return { kind: 'existing', nodeId: entry.nodeId, matchType: 'exact' }
      }
    }
  }

  // Fuzzy pass only after every entry has failed an exact match — an exact
  // match anywhere in the index must always win over a fuzzy one elsewhere.
  let best: { nodeId: string; distance: number } | null = null
  for (const entry of index) {
    for (const matcher of entry.matchers) {
      const normMatcher = normalise(matcher)
      // Short aliases ("SH") are exact-only: fuzzy-matching a 2-character
      // string is close to meaningless and would match almost anything.
      if (normMatcher.length < 4) continue
      const distance = levenshtein(target, normMatcher)
      if (distance <= fuzzyThreshold(normMatcher.length)) {
        if (!best || distance < best.distance) best = { nodeId: entry.nodeId, distance }
      }
    }
  }

  if (best) return { kind: 'existing', nodeId: best.nodeId, matchType: 'fuzzy' }
  return { kind: 'new', proposedName: extractedName }
}
