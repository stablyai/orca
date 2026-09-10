import type { MatchRange } from './palette-match/normalized-text'

export type PathHeadElisionSplit = {
  /** Leading directories, trailing separator included, safe to collapse first. */
  head: string
  /** Last segments that identify the path; every match lands here, re-based to it. */
  tail: string
  tailRanges: readonly MatchRange[]
}

const MIN_ELISION_LENGTH = 28
const MIN_SEGMENTS = 4
const TAIL_SEGMENTS = 2

/**
 * A deep path's identity lives in its tail (`…/services/checkout-api`), which is
 * exactly what a plain truncate throws away — two sibling paths then render
 * identically. Split so the head can elide while the tail keeps its width. The
 * tail extends back to the first matched segment so search evidence stays visible.
 */
export function splitPathHeadForElision(
  path: string,
  ranges: readonly MatchRange[] = []
): PathHeadElisionSplit | null {
  if (path.length <= MIN_ELISION_LENGTH) {
    return null
  }
  const separators: number[] = []
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === '/') {
      separators.push(index)
    }
  }
  if (separators.length < MIN_SEGMENTS - 1) {
    return null
  }
  let tailStart = separators[separators.length - TAIL_SEGMENTS]! + 1
  const firstMatchStart = ranges.reduce(
    (earliest, range) => (range.start < range.end ? Math.min(earliest, range.start) : earliest),
    Number.POSITIVE_INFINITY
  )
  if (firstMatchStart < tailStart) {
    const segmentSeparator = separators.findLast((separator) => separator < firstMatchStart)
    tailStart = segmentSeparator === undefined ? 0 : segmentSeparator + 1
  }
  const head = path.slice(0, tailStart)
  if (!/[^/]/.test(head)) {
    return null
  }
  return {
    head,
    tail: path.slice(tailStart),
    tailRanges: ranges.map((range) => ({
      start: range.start - tailStart,
      end: range.end - tailStart
    }))
  }
}
