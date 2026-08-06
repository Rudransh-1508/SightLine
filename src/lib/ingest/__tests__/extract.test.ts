import { describe, it, expect } from 'vitest'

import { MockLlmClient } from '@/lib/llm/mock'
import { extractFromDocument, ExtractionValidationError } from '../extract'

const VALID_EXTRACTION = {
  found: true,
  sourceEntity: 'Repsol',
  targetEntity: 'Sonatrach',
  relationshipType: 'contractual',
  direction: 'source-depends',
  strength: 70,
  state: 'strained',
  trajectory: 'improving',
  exposure: 'A quarter of gas supply',
  narrative: 'Price terms narrowed after review.',
  confidence: 'medium',
  evidenceQuote: 'Repsol and Sonatrach concluded a price review',
}

describe('extractFromDocument', () => {
  it('returns the parsed extraction on a valid response', async () => {
    const client = new MockLlmClient().respondWith(VALID_EXTRACTION)
    const result = await extractFromDocument(client, 'model', {
      title: 't',
      body: 'b',
    })
    expect(result).toEqual(VALID_EXTRACTION)
  })

  it('accepts found=false with every other field null', async () => {
    const client = new MockLlmClient().respondWith({
      found: false,
      sourceEntity: null,
      targetEntity: null,
      relationshipType: null,
      direction: null,
      strength: null,
      state: null,
      trajectory: null,
      exposure: null,
      narrative: null,
      confidence: null,
      evidenceQuote: null,
    })
    const result = await extractFromDocument(client, 'model', { title: 't', body: 'b' })
    expect(result.found).toBe(false)
  })

  it('throws ExtractionValidationError on a response missing required fields', async () => {
    const client = new MockLlmClient().respondWith({ found: true })
    await expect(
      extractFromDocument(client, 'model', { title: 't', body: 'b' }),
    ).rejects.toThrow(ExtractionValidationError)
  })

  it('throws on an invalid enum value', async () => {
    const client = new MockLlmClient().respondWith({
      ...VALID_EXTRACTION,
      state: 'furious', // not in REL_STATES
    })
    await expect(
      extractFromDocument(client, 'model', { title: 't', body: 'b' }),
    ).rejects.toThrow(ExtractionValidationError)
  })

  it('requests strict structured output with the extraction schema name', async () => {
    const client = new MockLlmClient().respondWith(VALID_EXTRACTION)
    await extractFromDocument(client, 'my-model', { title: 't', body: 'b' })
    expect(client.calls[0].model).toBe('my-model')
    expect(client.calls[0].schemaName).toBe('relationship_extraction')
  })

  it('includes the document title and body in the prompt', async () => {
    const client = new MockLlmClient().respondWith(VALID_EXTRACTION)
    await extractFromDocument(client, 'model', {
      title: 'Distinctive Title',
      body: 'Distinctive body content',
    })
    const content = client.calls[0].messages.map((m) => m.content).join('\n')
    expect(content).toContain('Distinctive Title')
    expect(content).toContain('Distinctive body content')
  })

  it('propagates a provider error', async () => {
    const client = new MockLlmClient().failWith(new Error('provider down'))
    await expect(
      extractFromDocument(client, 'model', { title: 't', body: 'b' }),
    ).rejects.toThrow(/provider down/)
  })
})
