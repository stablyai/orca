export type MarkdownFenceRanges = readonly (readonly [number, number])[]

export type MarkdownFenceTracker = {
  readonly insideFence: boolean
  // Returns true when the line was consumed as a fence delimiter.
  consume: (line: string) => boolean
}

// Top-level fence delimiters may be indented by at most three spaces.
const FENCE_LINE = /^[ ]{0,3}(`{3,}|~{3,})/
// marked lets a closer trail a run of fence characters, e.g. ```~~~ closes a ``` block.
const CLOSING_FENCE_SUFFIX = /^[~`]*[ \t\r]*$/

/** Tracks fenced blocks using the editor parser's closing rules. */
export function createMarkdownFenceTracker(): MarkdownFenceTracker {
  let marker = ''
  let length = 0

  return {
    get insideFence(): boolean {
      return length > 0
    },
    consume(line: string): boolean {
      const match = FENCE_LINE.exec(line)
      if (!match) {
        return false
      }
      const lineMarker = match[1][0]
      const lineLength = match[1].length
      const suffix = line.slice(match[0].length)

      if (length > 0) {
        if (lineMarker === marker && lineLength >= length && CLOSING_FENCE_SUFFIX.test(suffix)) {
          marker = ''
          length = 0
        }
        return true
      }

      if (lineMarker === '`' && suffix.includes('`')) {
        return false
      }
      marker = lineMarker
      length = lineLength
      return true
    }
  }
}

// Native scan: these run over whole documents, so per-character JS is too costly.
const LINE_BREAK = /[\n\r]/g

/**
 * End of the line at `start`, excluding its terminator. marked normalizes
 * `/\r\n|\r/g` to `\n` before parsing, so a lone CR ends a line here too.
 */
export function findMarkdownLineEnd(content: string, start: number): number {
  LINE_BREAK.lastIndex = start
  return LINE_BREAK.exec(content)?.index ?? content.length
}

/** Start of the line following the terminator at `lineEnd`. */
export function skipMarkdownLineBreak(content: string, lineEnd: number): number {
  if (content.charCodeAt(lineEnd) === 13 && content.charCodeAt(lineEnd + 1) === 10) {
    return lineEnd + 2
  }
  return lineEnd < content.length ? lineEnd + 1 : lineEnd
}

export function forEachMarkdownLine(
  content: string,
  visit: (lineStart: number, lineEnd: number, nextLineStart: number) => void
): void {
  let lineStart = 0
  for (;;) {
    const lineEnd = findMarkdownLineEnd(content, lineStart)
    const nextLineStart = skipMarkdownLineBreak(content, lineEnd)
    visit(lineStart, lineEnd, nextLineStart)
    if (lineEnd >= content.length) {
      return
    }
    lineStart = nextLineStart
  }
}

/** Offsets of every fenced code block, including its delimiter lines. */
export function getMarkdownFenceRanges(content: string): MarkdownFenceRanges {
  const ranges: [number, number][] = []
  const tracker = createMarkdownFenceTracker()
  let openStart = -1

  forEachMarkdownLine(content, (lineStart, lineEnd, nextLineStart) => {
    const wasInside = tracker.insideFence
    const isFenceLine = tracker.consume(content.slice(lineStart, lineEnd))
    if (!wasInside && isFenceLine) {
      openStart = lineStart
    } else if (wasInside && !tracker.insideFence) {
      ranges.push([openStart, nextLineStart])
      openStart = -1
    }
  })

  if (openStart !== -1) {
    ranges.push([openStart, content.length])
  }
  return ranges
}

export function isInsideMarkdownFenceRange(index: number, ranges: MarkdownFenceRanges): boolean {
  return ranges.some(([start, end]) => index >= start && index < end)
}

/** Same test for callers that probe non-decreasing offsets, in linear total time. */
export function createMarkdownFenceRangeCursor(
  ranges: MarkdownFenceRanges
): (index: number) => boolean {
  let cursor = 0
  return (index: number): boolean => {
    while (cursor < ranges.length && index >= ranges[cursor][1]) {
      cursor += 1
    }
    return cursor < ranges.length && index >= ranges[cursor][0]
  }
}
