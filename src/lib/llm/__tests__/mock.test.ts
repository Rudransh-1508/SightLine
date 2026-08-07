import { describe, it, expect } from 'vitest'

import { MockLlmClient } from '../mock'

describe('MockLlmClient', () => {
  it('returns queued responses in call order', async () => {
    const client = new MockLlmClient()
    client.respondWith({ a: 1 }).respondWith({ a: 2 })

    const call = (n: number) =>
      client.completeStructured({
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
        schema: {},
        schemaName: `call-${n}`,
      })

    expect(await call(1)).toEqual({ a: 1 })
    expect(await call(2)).toEqual({ a: 2 })
  })

  it('throws a queued error', async () => {
    const client = new MockLlmClient()
    client.failWith(new Error('rate limited'))

    await expect(
      client.completeStructured({
        model: 'm',
        messages: [],
        schema: {},
        schemaName: 's',
      }),
    ).rejects.toThrow(/rate limited/)
  })

  it('throws a clear error when the queue is empty, rather than hanging', async () => {
    const client = new MockLlmClient()
    await expect(
      client.completeStructured({ model: 'm', messages: [], schema: {}, schemaName: 's' }),
    ).rejects.toThrow(/no queued response/)
  })

  it('records every call for assertions', async () => {
    const client = new MockLlmClient()
    client.respondWith({}).respondWith({})
    await client.completeStructured({
      model: 'triage-model',
      messages: [],
      schema: {},
      schemaName: 'triage',
    })
    await client.completeStructured({
      model: 'extract-model',
      messages: [],
      schema: {},
      schemaName: 'extract',
    })

    expect(client.callCount).toBe(2)
    expect(client.calls.map((c) => c.model)).toEqual(['triage-model', 'extract-model'])
  })
})
