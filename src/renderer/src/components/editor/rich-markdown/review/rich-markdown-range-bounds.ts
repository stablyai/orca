import type { RichMarkdownAnnotationHighlightRange } from './rich-markdown-annotation-highlight'

export type RichMarkdownLineBlock = {
  readonly startLine: number
  readonly endLine: number
}

export type RichMarkdownLineRange = {
  lineNumber: number
  startLine?: number
}

export function getRichMarkdownLineRangeFromBlocks(
  blocks: readonly RichMarkdownLineBlock[]
): RichMarkdownLineRange | null {
  if (blocks.length === 0) {
    return null
  }

  let startLine = Number.POSITIVE_INFINITY
  let lineNumber = Number.NEGATIVE_INFINITY
  for (const block of blocks) {
    if (block.startLine < startLine) {
      startLine = block.startLine
    }
    if (block.endLine > lineNumber) {
      lineNumber = block.endLine
    }
  }

  return {
    lineNumber,
    startLine: startLine === lineNumber ? undefined : startLine
  }
}

export function getRichMarkdownRangeStart(
  ranges: readonly RichMarkdownAnnotationHighlightRange[]
): number | null {
  if (ranges.length === 0) {
    return null
  }

  let start = Number.POSITIVE_INFINITY
  for (const range of ranges) {
    const rangeStart = Math.min(range.from, range.to)
    if (rangeStart < start) {
      start = rangeStart
    }
  }
  return start
}

export function getRichMarkdownRangeBounds(
  ranges: readonly RichMarkdownAnnotationHighlightRange[]
): RichMarkdownAnnotationHighlightRange | null {
  if (ranges.length === 0) {
    return null
  }

  let from = Number.POSITIVE_INFINITY
  let to = Number.NEGATIVE_INFINITY
  for (const range of ranges) {
    const rangeStart = Math.min(range.from, range.to)
    const rangeEnd = Math.max(range.from, range.to)
    if (rangeStart < from) {
      from = rangeStart
    }
    if (rangeEnd > to) {
      to = rangeEnd
    }
  }
  return { from, to }
}
