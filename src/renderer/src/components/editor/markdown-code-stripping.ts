import {
  createMarkdownCodeSpanScanner,
  skipMarkdownBacktickRun
} from './markdown-code-span-scanner'
import { forEachMarkdownLine, getMarkdownFenceRanges } from './markdown-fence-scanner'

export function stripMarkdownCode(content: string): string {
  const ranges = getMarkdownCodeRanges(content)
  let rangeIndex = 0
  let sanitized = ''

  forEachMarkdownLine(content, (lineStart, lineEnd, nextLineStart) => {
    while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= lineStart) {
      rangeIndex += 1
    }
    // Emit the gaps between code ranges; the line break follows either way.
    let cursor = lineStart
    for (let i = rangeIndex; i < ranges.length && ranges[i][0] < lineEnd; i += 1) {
      sanitized += content.slice(cursor, Math.max(cursor, ranges[i][0]))
      cursor = Math.max(cursor, Math.min(ranges[i][1], lineEnd))
    }
    sanitized += content.slice(cursor, lineEnd)
    if (lineEnd < content.length) {
      sanitized += content.slice(lineEnd, nextLineStart)
    }
  })

  return sanitized
}

/** Fenced blocks and inline code spans, sorted and non-overlapping. */
function getMarkdownCodeRanges(content: string): [number, number][] {
  const fences = getMarkdownFenceRanges(content)
  const spans = createMarkdownCodeSpanScanner(content)
  const ranges: [number, number][] = []
  let fenceIndex = 0
  let index = 0

  while (index < content.length) {
    while (fenceIndex < fences.length && fences[fenceIndex][1] <= index) {
      fenceIndex += 1
    }
    if (fenceIndex < fences.length && index >= fences[fenceIndex][0]) {
      ranges.push([index, fences[fenceIndex][1]])
      index = fences[fenceIndex][1]
      continue
    }
    if (content[index] !== '`') {
      index += 1
      continue
    }
    // A run that never closes is literal text, not a delimiter.
    const spanEnd = spans.findSpanEnd(index)
    if (spanEnd === null) {
      index = skipMarkdownBacktickRun(content, index)
      continue
    }
    ranges.push([index, spanEnd])
    index = spanEnd
  }

  return ranges
}
