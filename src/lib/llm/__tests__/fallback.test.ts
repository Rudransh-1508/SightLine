import { describe, it, expect } from 'vitest'

import { FallbackLlmClient, AllProvidersExhaustedError } from '../fallback'
import { MockLlmClient } from '../mock'

class RateLimitError extends Error {
  status = 429
  constructor() {
    super('rate limited')
  }
}

const SCHEMA_PARAMS = {
  messages: [{ role: 'user' as const, content: 'x' }],
  schema: {},
  schemaName: 's',
}

describe('FallbackLlmClient — happy path', () => {
  it("returns the first provider's response without touching the rest", async () => {
    const primary = new MockLlmClient().respondWith({ ok: 'primary' })
    const secondary = new MockLlmClient().respondWith({ ok: 'secondary' })
    const client = new FallbackLlmClient([
      { client: primary, model: 'primary-model', label: 'groq' },
      { client: secondary, model: 'secondary-model', label: 'openrouter' },
    ])

    const result = await client.completeStructured({ ...SCHEMA_PARAMS, model: 'ignored' })

    expect(result).toEqual({ ok: 'primary' })
    expect(secondary.callCount).toBe(0)
  })

  it("calls the primary client with the CHAIN ENTRY's model, not the caller's", async () => {
    const primary = new MockLlmClient().respondWith({})
    const client = new FallbackLlmClient([
      { client: primary, model: 'groq-model', label: 'groq' },
    ])

    await client.completeStructured({ ...SCHEMA_PARAMS, model: 'whatever-caller-passed' })

    expect(primary.calls[0].model).toBe('groq-model')
  })
})

describe('FallbackLlmClient — rate-limit fallback', () => {
  it('falls back to the second provider on a 429, using ITS OWN model', async () => {
    const primary = new MockLlmClient().failWith(new RateLimitError())
    const secondary = new MockLlmClient().respondWith({ ok: 'secondary' })
    const client = new FallbackLlmClient([
      { client: primary, model: 'groq-model', label: 'groq' },
      { client: secondary, model: 'openrouter-model', label: 'openrouter' },
    ])

    const result = await client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' })

    expect(result).toEqual({ ok: 'secondary' })
    expect(secondary.calls[0].model).toBe('openrouter-model')
  })

  it('remembers an exhausted provider and skips it on every later call in the same run', async () => {
    const primary = new MockLlmClient()
      .failWith(new RateLimitError())
      .failWith(new RateLimitError())
    const secondary = new MockLlmClient().respondWith({ n: 1 }).respondWith({ n: 2 })
    const client = new FallbackLlmClient([
      { client: primary, model: 'g', label: 'groq' },
      { client: secondary, model: 'o', label: 'openrouter' },
    ])

    await client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' })
    await client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' })

    // Only the FIRST call should have actually tried the primary — after it
    // is marked exhausted, subsequent calls must skip straight to secondary.
    expect(primary.callCount).toBe(1)
    expect(secondary.callCount).toBe(2)
    expect(client.exhaustedProviders).toEqual(['groq'])
  })

  it('throws AllProvidersExhaustedError when every entry is rate-limited', async () => {
    const primary = new MockLlmClient().failWith(new RateLimitError())
    const secondary = new MockLlmClient().failWith(new RateLimitError())
    const client = new FallbackLlmClient([
      { client: primary, model: 'g', label: 'groq' },
      { client: secondary, model: 'o', label: 'openrouter' },
    ])

    await expect(
      client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' }),
    ).rejects.toBeInstanceOf(AllProvidersExhaustedError)
  })
})

/**
 * The most important behaviour in this file: a non-rate-limit failure must
 * NOT trigger fallback. Silently retrying a bad prompt against a second
 * provider would hide the bug and blur which provider produced the result.
 */
describe('FallbackLlmClient — non-rate-limit errors do not fall back', () => {
  it('propagates a schema-validation-style error immediately', async () => {
    const primary = new MockLlmClient().failWith(new Error('schema validation failed'))
    const secondary = new MockLlmClient().respondWith({ ok: true })
    const client = new FallbackLlmClient([
      { client: primary, model: 'g', label: 'groq' },
      { client: secondary, model: 'o', label: 'openrouter' },
    ])

    await expect(client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' })).rejects.toThrow(
      /schema validation failed/,
    )
    expect(secondary.callCount).toBe(0)
  })

  it('does not mark the failing provider exhausted for a non-429 error', async () => {
    const primary = new MockLlmClient()
      .failWith(new Error('transient non-rate-limit failure'))
      .respondWith({ ok: 'recovered' })
    const client = new FallbackLlmClient([{ client: primary, model: 'g', label: 'groq' }])

    await expect(client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' })).rejects.toThrow()
    // A second call should still try the SAME provider again — it was never
    // marked exhausted, because the failure wasn't a capacity problem.
    const result = await client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' })
    expect(result).toEqual({ ok: 'recovered' })
  })

  it('a 500 error is not treated as a rate limit', async () => {
    const err = new Error('server error') as Error & { status: number }
    err.status = 500
    const primary = new MockLlmClient().failWith(err)
    const secondary = new MockLlmClient().respondWith({})
    const client = new FallbackLlmClient([
      { client: primary, model: 'g', label: 'groq' },
      { client: secondary, model: 'o', label: 'openrouter' },
    ])

    await expect(client.completeStructured({ ...SCHEMA_PARAMS, model: 'x' })).rejects.toThrow(
      /server error/,
    )
    expect(secondary.callCount).toBe(0)
  })
})

describe('FallbackLlmClient — construction', () => {
  it('rejects an empty chain', () => {
    expect(() => new FallbackLlmClient([])).toThrow(/at least one/)
  })
})
