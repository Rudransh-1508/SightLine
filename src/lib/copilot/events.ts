/**
 * The wire format between /api/chat and the browser, and the parsing the
 * browser does with it.
 *
 * Deliberately free of any server or React import: the route, the agent and
 * the client component all share these definitions, and the parsing below is
 * pure so it can be tested in the node suite rather than needing a DOM.
 */

export type CopilotEvent =
  | { type: 'tool_call'; name: string; args: string }
  | { type: 'tool_result'; name: string; isError: boolean }
  | { type: 'delta'; text: string }
  /** Prose streamed so far was a preamble to a tool call — discard it. */
  | { type: 'reset' }
  | { type: 'citations'; nodes: string[]; edges: string[]; unverified: string[] }

export type ChatEvent =
  | CopilotEvent
  | {
      type: 'done'
      toolCalls: number
      creditsCharged: number
      balance: number
      unverified: string[]
    }
  | { type: 'error'; message: string }

/**
 * Reads an NDJSON body, calling `onEvent` per complete line.
 *
 * Chunk boundaries fall wherever the network puts them, not on newlines, so a
 * partial line is carried over rather than parsed — the naive
 * `chunk.split('\n').map(JSON.parse)` breaks the moment an event straddles two
 * chunks, which for a streamed answer is most of them.
 *
 * A line that fails to parse is skipped rather than aborting the stream: one
 * corrupt frame should not discard an answer that is otherwise arriving fine.
 */
export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: ChatEvent) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const flush = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      onEvent(JSON.parse(trimmed) as ChatEvent)
    } catch {
      // Ignore an unparseable frame; the rest of the stream is still good.
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    // The last element is whatever came after the final newline — possibly a
    // complete line with no trailing newline yet, so it waits for more input.
    buffer = lines.pop() ?? ''
    for (const line of lines) flush(line)
  }

  buffer += decoder.decode()
  flush(buffer)
}

// --- citation rendering -----------------------------------------------------

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }

const CITATION = /\[(node|edge):([^\]\s]+)\]/g
const BOLD = /\*\*([^*]+)\*\*/g
/** Citation or bold run, whichever comes next. */
const INLINE = new RegExp(`${CITATION.source}|${BOLD.source}`, 'g')

/**
 * Splits an answer into text and citation segments for rendering.
 *
 * Handles the half-written case, which matters because this runs on every
 * streamed delta: a trailing `[node:sona` is held back as `pending` rather
 * than rendered as literal text that would flicker into a chip a moment
 * later. Anything before the last unclosed bracket is safe to render.
 */
export function segmentAnswer(text: string): { segments: AnswerSegment[]; pending: string } {
  const lastOpen = text.lastIndexOf('[')
  const hasOpenTail = lastOpen !== -1 && !text.slice(lastOpen).includes(']')
  const safe = hasOpenTail ? text.slice(0, lastOpen) : text
  const pending = hasOpenTail ? text.slice(lastOpen) : ''

  const segments: AnswerSegment[] = []
  let cursor = 0

  for (const match of safe.matchAll(INLINE)) {
    const start = match.index ?? 0
    if (start > cursor) segments.push({ kind: 'text', text: safe.slice(cursor, start) })
    if (match[1]) {
      segments.push({ kind: match[1] as 'node' | 'edge', id: match[2] })
    } else {
      segments.push({ kind: 'bold', text: match[3] })
    }
    cursor = start + match[0].length
  }
  if (cursor < safe.length) segments.push({ kind: 'text', text: safe.slice(cursor) })

  return { segments, pending }
}

export interface AnswerBlock {
  kind: 'paragraph' | 'bullet'
  segments: AnswerSegment[]
}

/**
 * Turns a streamed answer into blocks to render.
 *
 * The prompt asks for a lead sentence and up to three bullets and forbids
 * tables, but a prompt is a request, not a guarantee — the first live answers
 * came back as markdown tables. So the rendering degrades rather than leaks:
 * bullets and bold become real elements, a table row is flattened to a bullet
 * with its cells joined, and separator rows are dropped. Nothing reaches the
 * reader as raw `**` or `|`.
 */
export function parseAnswer(text: string): { blocks: AnswerBlock[]; pending: string } {
  const { pending } = segmentAnswer(text)
  const safe = pending ? text.slice(0, text.length - pending.length) : text

  const blocks: AnswerBlock[] = []
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', segments: segmentAnswer(paragraph.join(' ')).segments })
    paragraph = []
  }

  for (const rawLine of safe.split('\n')) {
    const line = rawLine.trim()

    if (!line) {
      flushParagraph()
      continue
    }

    // A markdown table the model was asked not to write. Its separator row
    // carries no content; every other row becomes one bullet.
    if (line.startsWith('|')) {
      const cells = line
        .split('|')
        .map((c) => c.trim())
        .filter(Boolean)
      if (cells.length === 0 || cells.every((c) => /^:?-{2,}:?$/.test(c))) continue
      flushParagraph()
      blocks.push({ kind: 'bullet', segments: segmentAnswer(cells.join(' · ')).segments })
      continue
    }

    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (bullet) {
      flushParagraph()
      blocks.push({ kind: 'bullet', segments: segmentAnswer(bullet[1]).segments })
      continue
    }

    // Headings are not worth their own level in a 352px panel; the text still
    // matters, so it becomes an emphasised line rather than being dropped.
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'paragraph', segments: [{ kind: 'bold', text: heading[1] }] })
      continue
    }

    paragraph.push(line)
  }

  flushParagraph()
  return { blocks, pending }
}

/** Parses an edge id (`source->target:type`) back into its parts. */
export function parseEdgeId(
  id: string,
): { source: string; target: string; type: string } | null {
  const arrow = id.indexOf('->')
  if (arrow === -1) return null
  const colon = id.lastIndexOf(':')
  if (colon <= arrow + 2) return null
  return {
    source: id.slice(0, arrow),
    target: id.slice(arrow + 2, colon),
    type: id.slice(colon + 1),
  }
}
