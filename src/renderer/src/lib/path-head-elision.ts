import type { MatchRange } from './palette-match/normalized-text'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'

export type PathHeadElisionSplit = {
  head: string
  tail: string
  tailRanges: readonly MatchRange[]
}

const MIN_ELISION_LENGTH = 28
const MIN_SEGMENTS = 4
const TAIL_SEGMENTS = 2

export function splitPathHeadForElision(
  path: string,
  ranges: readonly MatchRange[] = []
): PathHeadElisionSplit | null {
  if (path.length <= MIN_ELISION_LENGTH) {
    return null
  }
  const windowsPath = isWindowsAbsolutePathLike(path)
  const separators: number[] = []
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] === '/' || (windowsPath && path[index] === '\\')) {
      separators.push(index)
    }
  }
  if (separators.length < MIN_SEGMENTS - 1) {
    return null
  }
  let tailStart = separators[separators.length - TAIL_SEGMENTS]!
  const firstMatchStart = ranges.reduce(
    (earliest, range) => (range.start < range.end ? Math.min(earliest, range.start) : earliest),
    Number.POSITIVE_INFINITY
  )
  if (firstMatchStart < tailStart) {
    const segmentSeparator = separators.findLast((separator) => separator < firstMatchStart)
    tailStart = segmentSeparator ?? 0
  }
  const head = path.slice(0, tailStart)
  if (!(windowsPath ? /[^/\\]/ : /[^/]/).test(head)) {
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
