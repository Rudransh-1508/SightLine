import { describe, it, expect } from 'vitest'

import {
  readChatStream,
  segmentAnswer,
  parseAnswer,
  parseEdgeId,
  type ChatEvent,
} from '../events'

/**
 * The browser side of the copilot, kept as pure functions precisely so it can
 * be tested here rather than needing a DOM: stream framing and the citation
 * segmentation that turns an answer into clickable chips.
 */

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
}

async function collect(chunks: string[]): Promise<ChatEvent[]> {
  const events: ChatEvent[] = []
  await readChatStream(streamOf(chunks), (e) => events.push(e))
  return events
}

describe('readChatStream', () => {
  it('reads one event per line', async () => {
    const events = await collect(['{"type":"delta","text":"Repsol"}\n{"type":"reset"}\n'])
    expect(events).toEqual([{ type: 'delta', text: 'Repsol' }, { type: 'reset' }])
  })

  /**
   * The case that breaks the naive implementation: chunk boundaries fall
   * wherever the network puts them, and for a streamed answer most events
   * straddle two chunks.
   */
  it('reassembles an event split across chunks', async () => {
    const events = await collect(['{"type":"delta","te', 'xt":"hello"}\n'])
    expect(events).toEqual([{ type: 'delta', text: 'hello' }])
  })

  it('handles several events arriving in one chunk', async () => {
    const events = await collect(['{"type":"delta","text":"a"}\n{"type":"delta","text":"b"}\n'])
    expect(events.map((e) => (e.type === 'delta' ? e.text : ''))).toEqual(['a', 'b'])
  })

  it('emits a final line that arrives without a trailing newline', async () => {
    const events = await collect([
      '{"type":"done","toolCalls":1,"creditsCharged":3,"balance":97,"unverified":[]}',
    ])
    expect(events).toEqual([
      { type: 'done', toolCalls: 1, creditsCharged: 3, balance: 97, unverified: [] },
    ])
  })

  it('does not split a multi-byte character across chunks', async () => {
    // "→" is three bytes; cut it in half at the chunk boundary.
    const encoded = new TextEncoder().encode('{"type":"delta","text":"a→b"}\n')
    const events: ChatEvent[] = []
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 26))
        controller.enqueue(encoded.slice(26))
        controller.close()
      },
    })

    await readChatStream(stream, (e) => events.push(e))

    expect(events).toEqual([{ type: 'delta', text: 'a→b' }])
  })

  /** One corrupt frame must not discard an answer that is otherwise fine. */
  it('skips an unparseable line and keeps going', async () => {
    const events = await collect(['not json\n{"type":"delta","text":"ok"}\n'])
    expect(events).toEqual([{ type: 'delta', text: 'ok' }])
  })

  it('ignores blank lines', async () => {
    const events = await collect(['\n\n{"type":"reset"}\n\n'])
    expect(events).toEqual([{ type: 'reset' }])
  })
})

describe('segmentAnswer', () => {
  it('splits prose from citations', () => {
    const { segments } = segmentAnswer('Repsol [node:repsol] depends on gas.')
    expect(segments).toEqual([
      { kind: 'text', text: 'Repsol ' },
      { kind: 'node', id: 'repsol' },
      { kind: 'text', text: ' depends on gas.' },
    ])
  })

  it('reads an edge citation, arrow and all', () => {
    const { segments } = segmentAnswer('via [edge:repsol->sonatrach:contractual]')
    expect(segments[1]).toEqual({ kind: 'edge', id: 'repsol->sonatrach:contractual' })
  })

  /**
   * This runs on every streamed delta, so a citation is repeatedly seen
   * half-written. Rendering the fragment as literal text would make it flicker
   * into a chip a moment later.
   */
  it('holds back a half-streamed citation instead of rendering it as text', () => {
    const { segments, pending } = segmentAnswer('Gas via [node:sona')
    expect(segments).toEqual([{ kind: 'text', text: 'Gas via ' }])
    expect(pending).toBe('[node:sona')
  })

  it('renders the citation once the closing bracket arrives', () => {
    const { segments, pending } = segmentAnswer('Gas via [node:sonatrach]')
    expect(segments[1]).toEqual({ kind: 'node', id: 'sonatrach' })
    expect(pending).toBe('')
  })

  it('leaves an unrelated bracket alone', () => {
    const { segments } = segmentAnswer('A note [see below] here.')
    expect(segments).toEqual([{ kind: 'text', text: 'A note [see below] here.' }])
  })

  it('handles several citations in one sentence', () => {
    const { segments } = segmentAnswer('[node:a] and [node:b]')
    expect(segments.filter((s) => s.kind === 'node')).toHaveLength(2)
  })

  it('returns nothing for an empty answer', () => {
    expect(segmentAnswer('')).toEqual({ segments: [], pending: '' })
  })
})

/**
 * The prompt asks for a lead sentence and up to three bullets and forbids
 * tables — but a prompt is a request, not a guarantee, and the first live
 * answers came back as wide markdown tables. These tests pin the degradation:
 * whatever the model writes, nothing reaches the reader as raw `**` or `|`.
 */
describe('parseAnswer', () => {
  it('renders bold as a segment rather than literal asterisks', () => {
    const { blocks } = parseAnswer('The **levy** is the largest exposure.')
    expect(blocks[0].segments).toEqual([
      { kind: 'text', text: 'The ' },
      { kind: 'bold', text: 'levy' },
      { kind: 'text', text: ' is the largest exposure.' },
    ])
  })

  it('reads a bullet list, in any of the markers a model reaches for', () => {
    const { blocks } = parseAnswer('Lead line.\n\n- first\n* second\n3. third\n• fourth')
    expect(blocks.map((b) => b.kind)).toEqual([
      'paragraph',
      'bullet',
      'bullet',
      'bullet',
      'bullet',
    ])
    expect(blocks[1].segments).toEqual([{ kind: 'text', text: 'first' }])
  })

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    const { blocks } = parseAnswer('one\ntwo\n\nthree')
    expect(blocks).toHaveLength(2)
    expect(blocks[0].segments).toEqual([{ kind: 'text', text: 'one two' }])
  })

  it('flattens a forbidden table into bullets and drops its separator row', () => {
    const { blocks } = parseAnswer(
      'Top three.\n\n| Edge | Strength |\n|------|----------|\n| [edge:a->b:equity] | 90 |',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'bullet', 'bullet'])
    // The header row survives as a bullet; the dashes do not.
    expect(blocks[1].segments).toEqual([{ kind: 'text', text: 'Edge · Strength' }])
    expect(blocks[2].segments[0]).toEqual({ kind: 'edge', id: 'a->b:equity' })
  })

  it('keeps citations working inside a bullet', () => {
    const { blocks } = parseAnswer('- the levy [edge:repsol->spain:political] is largest')
    expect(blocks[0].kind).toBe('bullet')
    expect(blocks[0].segments).toContainEqual({ kind: 'edge', id: 'repsol->spain:political' })
  })

  it('demotes a heading to an emphasised line instead of dropping it', () => {
    const { blocks } = parseAnswer('## Venezuela cluster\ndetail')
    expect(blocks[0].segments).toEqual([{ kind: 'bold', text: 'Venezuela cluster' }])
    expect(blocks[1].segments).toEqual([{ kind: 'text', text: 'detail' }])
  })

  it('still holds back a half-streamed citation', () => {
    const { blocks, pending } = parseAnswer('- gas via [node:sona')
    expect(pending).toBe('[node:sona')
    // Block parsing trims the line, so the held-back fragment leaves no
    // trailing space behind it.
    expect(blocks[0].segments).toEqual([{ kind: 'text', text: 'gas via' }])
  })

  it('returns no blocks for an empty answer', () => {
    expect(parseAnswer('')).toEqual({ blocks: [], pending: '' })
  })
})

describe('parseEdgeId', () => {
  it('splits an edge id into its parts', () => {
    expect(parseEdgeId('repsol->sonatrach:contractual')).toEqual({
      source: 'repsol',
      target: 'sonatrach',
      type: 'contractual',
    })
  })

  it('keeps a hyphen inside an id out of the arrow', () => {
    expect(parseEdgeId('repsol-sa->cnmc:regulatory')).toMatchObject({
      source: 'repsol-sa',
      target: 'cnmc',
    })
  })

  it('rejects an id that is not in edge form', () => {
    expect(parseEdgeId('repsol')).toBeNull()
    expect(parseEdgeId('repsol->sonatrach')).toBeNull()
  })
})
