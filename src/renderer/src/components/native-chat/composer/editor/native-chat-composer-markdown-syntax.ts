export type NativeChatMarkdownBlock =
  | { kind: 'text' }
  | { kind: 'heading'; level: number }
  | { kind: 'quote' }
  | { kind: 'bullet' }
  | { kind: 'ordered' }
  | { kind: 'rule' }
  | { kind: 'fence' }
  | { kind: 'code' }

export type NativeChatMarkdownSpanKind =
  | 'marker'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'bullet-marker'

/** `from`..`to` are offsets in the line's text. */
export type NativeChatMarkdownSpan = { from: number; to: number; kind: NativeChatMarkdownSpanKind }

export type NativeChatMarkdownLine = {
  block: NativeChatMarkdownBlock
  spans: NativeChatMarkdownSpan[]
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const HEADING = /^ {0,3}(#{1,6})(?=\s|$)\s?/
const QUOTE = /^ {0,3}(?:>[ \t]?)+/
const SETEXT_DASHES = /^ {0,3}-+[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const BULLET = /^[ \t]*[-*+](?=[ \t])[ \t]?/
const ORDERED = /^[ \t]*\d{1,9}[.)](?=[ \t])[ \t]?/

type FenceState = { char: string; length: number } | null

/** The block each line is, with the spans to style in it; only syntax the chat renders the same way. */
export function classifyNativeChatMarkdown(lines: readonly string[]): NativeChatMarkdownLine[] {
  let fence: FenceState = null
  let previousIsText = false
  return lines.map((line) => {
    const result = classifyLine(line, fence, previousIsText)
    fence = result.fence
    previousIsText = result.line.block.kind === 'text' && line.trim() !== ''
    return result.line
  })
}

function classifyLine(
  line: string,
  fence: FenceState,
  previousIsText: boolean
): { line: NativeChatMarkdownLine; fence: FenceState } {
  const fenceMatch = FENCE.exec(line)
  if (fence) {
    const closes =
      fenceMatch !== null &&
      fenceMatch[1][0] === fence.char &&
      fenceMatch[1].length >= fence.length &&
      line.slice(fenceMatch[0].length).trim() === ''
    return closes
      ? { line: { block: { kind: 'fence' }, spans: [whole(line, 'marker')] }, fence: null }
      : { line: { block: { kind: 'code' }, spans: [] }, fence }
  }
  // A backtick fence's info string can't hold a backtick, so a line like ```a``` is inline code.
  if (fenceMatch && !(fenceMatch[1][0] === '`' && line.slice(fenceMatch[0].length).includes('`'))) {
    return {
      line: { block: { kind: 'fence' }, spans: [whole(line, 'marker')] },
      fence: { char: fenceMatch[1][0], length: fenceMatch[1].length }
    }
  }
  // `---` under a text line is a setext heading in the chat, not a rule.
  if (RULE.test(line) && !(previousIsText && SETEXT_DASHES.test(line))) {
    return { line: { block: { kind: 'rule' }, spans: [whole(line, 'marker')] }, fence: null }
  }
  const heading = HEADING.exec(line)
  if (heading) {
    return {
      line: {
        block: { kind: 'heading', level: heading[1].length },
        spans: [
          { from: 0, to: heading[0].length, kind: 'marker' },
          ...inline(line, heading[0].length)
        ]
      },
      fence: null
    }
  }
  const quote = QUOTE.exec(line)
  if (quote) {
    return {
      line: {
        block: { kind: 'quote' },
        spans: [{ from: 0, to: quote[0].length, kind: 'marker' }, ...inline(line, quote[0].length)]
      },
      fence: null
    }
  }
  const bullet = BULLET.exec(line)
  const ordered = bullet ? null : ORDERED.exec(line)
  const list = bullet ?? ordered
  if (list) {
    const markerFrom = list[0].length - list[0].trimStart().length
    return {
      line: {
        block: { kind: bullet ? 'bullet' : 'ordered' },
        spans: [
          { from: markerFrom, to: list[0].length, kind: 'bullet-marker' },
          ...inline(line, list[0].length)
        ]
      },
      fence: null
    }
  }
  return { line: { block: { kind: 'text' }, spans: inline(line, 0) }, fence: null }
}

function whole(line: string, kind: NativeChatMarkdownSpanKind): NativeChatMarkdownSpan {
  return { from: 0, to: line.length, kind }
}

const EMPHASIS: { pattern: RegExp; marker: number; kinds: NativeChatMarkdownSpanKind[] }[] = [
  { pattern: /(\*\*\*)(?=\S)(.+?)(?<=\S)\1/g, marker: 3, kinds: ['bold', 'italic'] },
  {
    pattern: /(?<![\p{L}\p{N}_])(___)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu,
    marker: 3,
    kinds: ['bold', 'italic']
  },
  { pattern: /(\*\*)(?=\S)(.+?)(?<=\S)\1/g, marker: 2, kinds: ['bold'] },
  {
    pattern: /(?<![\p{L}\p{N}_])(__)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu,
    marker: 2,
    kinds: ['bold']
  },
  { pattern: /(~~)(?=\S)(.+?)(?<=\S)\1/g, marker: 2, kinds: ['strike'] },
  { pattern: /(\*)(?=[^\s*])(.+?)(?<=[^\s*])\1/g, marker: 1, kinds: ['italic'] },
  {
    pattern: /(?<![\p{L}\p{N}_])(_)(?=[^\s_])(.+?)(?<=[^\s_])\1(?![\p{L}\p{N}_])/gu,
    marker: 1,
    kinds: ['italic']
  }
]

const MASK = '\u0000'

function mask(text: string, from: number, to: number): string {
  return text.slice(0, from) + MASK.repeat(to - from) + text.slice(to)
}

/** Code spans first (a backslash is literal inside them), then escapes, then emphasis; consumed
 *  markers are masked so spans nest. */
function inline(line: string, start: number): NativeChatMarkdownSpan[] {
  const spans: NativeChatMarkdownSpan[] = []
  let text = mask(line, 0, start)
  let index = start
  while (index < line.length) {
    if (line[index] === '\\') {
      text = mask(text, index, Math.min(index + 2, line.length))
      index += 2
    } else if (line[index] === '`') {
      const tick = /^`+/.exec(line.slice(index))![0].length
      const close = findClosingTicks(line, index + tick, tick)
      if (close < 0) {
        index += tick
        continue
      }
      spans.push(
        { from: index, to: index + tick, kind: 'marker' },
        { from: index + tick, to: close, kind: 'code' },
        { from: close, to: close + tick, kind: 'marker' }
      )
      text = mask(text, index, close + tick)
      index = close + tick
    } else {
      index++
    }
  }
  for (const { pattern, marker, kinds } of EMPHASIS) {
    for (const match of text.matchAll(pattern)) {
      const from = match.index
      const to = from + match[0].length
      spans.push(
        { from, to: from + marker, kind: 'marker' },
        ...kinds.map((kind) => ({ from: from + marker, to: to - marker, kind })),
        { from: to - marker, to, kind: 'marker' }
      )
      text = mask(text, from, from + marker)
      text = mask(text, to - marker, to)
    }
  }
  return spans
}

/** Where a run of exactly `length` backticks starts at or after `from`, or -1. */
function findClosingTicks(line: string, from: number, length: number): number {
  let index = from
  while (index < line.length) {
    if (line[index] !== '`') {
      index++
      continue
    }
    const run = /^`+/.exec(line.slice(index))![0].length
    if (run === length && index > from) {
      return index
    }
    index += run
  }
  return -1
}
