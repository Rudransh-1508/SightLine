import { describe, it, expect } from 'vitest'

import { verifyEvidenceQuote } from '../evidence'

const SOURCE = 'Repsol and Sonatrach concluded a price review in May 2026 on narrower terms.'

describe('verifyEvidenceQuote', () => {
  it('accepts a quote that appears verbatim', () => {
    expect(verifyEvidenceQuote('Repsol and Sonatrach concluded a price review', SOURCE)).toBe(
      true,
    )
  })

  it('rejects a fabricated quote', () => {
    expect(verifyEvidenceQuote('Repsol terminated all contracts with Sonatrach', SOURCE)).toBe(
      false,
    )
  })

  it('rejects a paraphrase — this is a verbatim check, not a fuzzy one', () => {
    expect(verifyEvidenceQuote('Repsol and Sonatrach agreed on new pricing', SOURCE)).toBe(
      false,
    )
  })

  it('is tolerant of whitespace differences', () => {
    expect(verifyEvidenceQuote('Repsol   and Sonatrach\nconcluded', SOURCE)).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(verifyEvidenceQuote('REPSOL AND SONATRACH', SOURCE)).toBe(true)
  })

  it('rejects null', () => {
    expect(verifyEvidenceQuote(null, SOURCE)).toBe(false)
  })

  it('rejects an empty or whitespace-only quote', () => {
    expect(verifyEvidenceQuote('', SOURCE)).toBe(false)
    expect(verifyEvidenceQuote('   ', SOURCE)).toBe(false)
  })

  it('rejects a quote assembled from two separate parts of the source', () => {
    // "Repsol and Sonatrach" ... "on narrower terms" are both real substrings,
    // but stitched together they never appeared as one sentence.
    expect(verifyEvidenceQuote('Repsol and Sonatrach on narrower terms', SOURCE)).toBe(false)
  })
})
