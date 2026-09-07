import { parseExplicitFileLinkTarget } from './explicit-file-link-target'
import type { ParsedTerminalFileLink } from './terminal-links'

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

export type DetectedTerminalFileLinkRange = {
  startIndex: number
  endIndex: number
  text: string
}

function trimBoundaryPunctuation(
  value: string,
  startIndex: number
): DetectedTerminalFileLinkRange | null {
  let start = 0
  let end = value.length

  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }

  if (start >= end) {
    return null
  }

  return {
    text: value.slice(start, end),
    startIndex: startIndex + start,
    endIndex: startIndex + end
  }
}

export function* detectTerminalFileLinkRanges(
  lineText: string,
  regex: RegExp
): Generator<DetectedTerminalFileLinkRange> {
  for (const match of lineText.matchAll(regex)) {
    const rawStart = match.index ?? 0
    const trimmed = trimBoundaryPunctuation(match[0], rawStart)
    if (trimmed) {
      yield trimmed
    }
  }
}

export function mergeTerminalFileLinkRanges(ranges: [number, number][]): [number, number][] {
  if (ranges.length <= 1) {
    return ranges
  }
  const sorted = ranges.slice().sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: [number, number][] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (!last || range[0] > last[1]) {
      merged.push([range[0], range[1]])
      continue
    }
    last[1] = Math.max(last[1], range[1])
  }
  return merged
}

export function terminalFileLinkRangesOverlap(
  range: DetectedTerminalFileLinkRange,
  claimedRanges: readonly [number, number][]
): boolean {
  // Why: generated terminal lines can contain thousands of file-looking tokens;
  // overlap checks must stay logarithmic instead of scanning every prior range.
  let low = 0
  let high = claimedRanges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (claimedRanges[mid][0] < range.endIndex) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  const previous = claimedRanges[low - 1]
  return previous !== undefined && previous[1] > range.startIndex
}

export function insertTerminalFileLinkClaimedRange(
  claimedRanges: [number, number][],
  range: [number, number]
): void {
  const last = claimedRanges.at(-1)
  if (!last || last[0] <= range[0]) {
    claimedRanges.push(range)
    return
  }

  let low = 0
  let high = claimedRanges.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (claimedRanges[mid][0] <= range[0]) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  claimedRanges.splice(low, 0, range)
}

export function toParsedTerminalFileLink(
  range: DetectedTerminalFileLinkRange
): ParsedTerminalFileLink | null {
  const parsed = parseExplicitFileLinkTarget(range.text)
  if (!parsed) {
    return null
  }
  return {
    pathText: parsed.pathText,
    line: parsed.line,
    column: parsed.column,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    displayText: range.text
  }
}
