import { describe, it, expect } from 'vitest'

import { MockLlmClient } from '@/lib/llm/mock'
import { triageBatch, type TriageInput } from '../triage'

function doc(over: Partial<TriageInput> = {}): TriageInput {
  return { title: 'A story', body: 'Some body text.', matchedNodeIds: ['repsol'], ...over }
}

describe('triageBatch', () => {
  it('returns nothing for an empty batch without calling the model', async () => {
    const client = new MockLlmClient()
    const result = await triageBatch(client, 'model', [])
    expect(result).toEqual([])
    expect(client.callCount).toBe(0)
  })

  it('classifies exactly one document per input, in order', async () => {
    const client = new MockLlmClient().respondWith({
      results: [
        { index: 0, relevant: true },
        { index: 1, relevant: false },
      ],
    })
    const docs = [doc({ title: 'Relevant' }), doc({ title: 'Not relevant' })]
    const result = await triageBatch(client, 'model', docs)

    expect(result).toHaveLength(2)
    expect(result[0].relevant).toBe(true)
    expect(result[0].doc.title).toBe('Relevant')
    expect(result[1].relevant).toBe(false)
  })

  it('makes exactly one call regardless of batch size', async () => {
    const client = new MockLlmClient().respondWith({
      results: Array.from({ length: 20 }, (_, i) => ({ index: i, relevant: true })),
    })
    await triageBatch(
      client,
      'model',
      Array.from({ length: 20 }, () => doc()),
    )
    expect(client.callCount).toBe(1)
  })

  it('fails open (treats as relevant) when the model omits an index', async () => {
    const client = new MockLlmClient().respondWith({ results: [{ index: 0, relevant: false }] })
    const result = await triageBatch(client, 'model', [doc(), doc()])
    expect(result[0].relevant).toBe(false)
    expect(result[1].relevant).toBe(true) // no verdict returned -> fail open
  })

  it('fails open for every document when the response fails schema validation', async () => {
    const client = new MockLlmClient().respondWith({ garbage: true })
    const result = await triageBatch(client, 'model', [doc(), doc()])
    expect(result.every((r) => r.relevant)).toBe(true)
  })

  it('passes the model, batch size and matched entities into the prompt', async () => {
    const client = new MockLlmClient().respondWith({ results: [{ index: 0, relevant: true }] })
    await triageBatch(client, 'my-triage-model', [
      doc({ title: 'Repsol-Sonatrach deal', matchedNodeIds: ['repsol', 'sonatrach'] }),
    ])

    const call = client.calls[0]
    expect(call.model).toBe('my-triage-model')
    expect(call.messages.map((m) => m.content).join('\n')).toContain('Repsol-Sonatrach deal')
    expect(call.messages.map((m) => m.content).join('\n')).toContain('repsol, sonatrach')
  })

  it('requests strict structured output', async () => {
    const client = new MockLlmClient().respondWith({ results: [{ index: 0, relevant: true }] })
    await triageBatch(client, 'model', [doc()])
    expect(client.calls[0].schemaName).toBe('triage_batch')
    expect(client.calls[0].schema).toBeTruthy()
  })

  it('propagates a provider error rather than swallowing it', async () => {
    const client = new MockLlmClient().failWith(new Error('rate limited'))
    await expect(triageBatch(client, 'model', [doc()])).rejects.toThrow(/rate limited/)
  })
})
