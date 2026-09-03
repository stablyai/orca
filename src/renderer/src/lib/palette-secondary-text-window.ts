import type { MatchRange } from './palette-match/normalized-text'

/**
 * The URL/path line shares one row with the tab title, so it gets a fixed
 * character budget instead of whatever width its content asks for.
 */
export const PALETTE_SECONDARY_TEXT_BUDGET = 38

const ELLIPSIS = '…'
/** Kept when the window jumps to a match, so the URL host stays recognizable. */
const HEAD_BUDGET = 18
const MATCH_LEAD_CONTEXT = 6
/** Below this the jump costs more than it reveals; head truncation wins. */
const MIN_MATCH_WINDOW = 10

export type PaletteSecondaryTextWindow = {
  text: string
  ranges: readonly MatchRange[]
  elided: boolean
}

function resolveHeadLength(text: string): number {
  const separator = text.search(/[/?#]/)
  if (separator > 0 && separator <= HEAD_BUDGET) {
    return separator
  }
  return HEAD_BUDGET
}

/** Clips ranges to `[start, end)` and rebases them onto the emitted substring. */
function rebaseRanges(
  ranges: readonly MatchRange[],
  start: number,
  end: number,
  outputStart: number
): MatchRange[] {
  const rebased: MatchRange[] = []
  for (const range of ranges) {
    const clippedStart = Math.max(range.start, start)
    const clippedEnd = Math.min(range.end, end)
    if (clippedEnd > clippedStart) {
      rebased.push({
        start: outputStart + clippedStart - start,
        end: outputStart + clippedEnd - start
      })
    }
  }
  return rebased
}

/**
 * Truncates the secondary line to `budget` characters, keeping the first match
 * visible: a match past the budget pulls a window in after the head, so a row
 * still shows why the query hit it.
 */
export function windowPaletteSecondaryText(
  text: string,
  ranges: readonly MatchRange[] = [],
  budget: number = PALETTE_SECONDARY_TEXT_BUDGET
): PaletteSecondaryTextWindow {
  if (text.length <= budget) {
    return { text, ranges, elided: false }
  }
  const firstMatch = ranges.find((range) => range.end > range.start)
  const headOnlyEnd = budget - ELLIPSIS.length
  const headLength = resolveHeadLength(text)
  const windowBudget = budget - headLength - ELLIPSIS.length * 2
  if (!firstMatch || firstMatch.end <= headOnlyEnd || windowBudget < MIN_MATCH_WINDOW) {
    return {
      text: `${text.slice(0, headOnlyEnd)}${ELLIPSIS}`,
      ranges: rebaseRanges(ranges, 0, headOnlyEnd, 0),
      elided: true
    }
  }
  const windowStart = Math.min(
    Math.max(firstMatch.start - MATCH_LEAD_CONTEXT, headLength),
    text.length - windowBudget
  )
  const windowEnd = Math.min(text.length, windowStart + windowBudget)
  const gap = windowStart > headLength ? ELLIPSIS : ''
  const tail = windowEnd < text.length ? ELLIPSIS : ''
  return {
    text: `${text.slice(0, headLength)}${gap}${text.slice(windowStart, windowEnd)}${tail}`,
    ranges: [
      ...rebaseRanges(ranges, 0, headLength, 0),
      ...rebaseRanges(ranges, windowStart, windowEnd, headLength + gap.length)
    ],
    elided: true
  }
}
