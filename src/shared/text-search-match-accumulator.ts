import type { SearchFileResult, SearchMatch } from './code-search-types'
import type { SearchAccumulator } from './text-search'

const MAX_LINE_CONTENT_LENGTH = 500
const TRUNCATION_MARKER = '…'

type ClampedLineContext = {
  lineContent: string
  column: number
  matchLength: number
  displayColumn?: number
  displayMatchLength?: number
}

function clampLineContext(
  text: string,
  matchStart: number,
  matchLength: number
): ClampedLineContext {
  if (text.length <= MAX_LINE_CONTENT_LENGTH) {
    return { lineContent: text, column: matchStart + 1, matchLength }
  }
  const clampedMatchLength = Math.min(matchLength, MAX_LINE_CONTENT_LENGTH)
  const remaining = MAX_LINE_CONTENT_LENGTH - clampedMatchLength
  const leftBudget = Math.floor(remaining / 2)
  let windowStart = Math.max(0, matchStart - leftBudget)
  const windowEnd = Math.min(text.length, windowStart + MAX_LINE_CONTENT_LENGTH)
  windowStart = Math.max(0, windowEnd - MAX_LINE_CONTENT_LENGTH)

  let snippet = text.slice(windowStart, windowEnd)
  let column = matchStart - windowStart + 1
  if (windowStart > 0) {
    snippet = TRUNCATION_MARKER + snippet
    column += TRUNCATION_MARKER.length
  }
  if (windowEnd < text.length) {
    snippet += TRUNCATION_MARKER
  }
  return {
    lineContent: snippet,
    column: matchStart + 1,
    matchLength,
    displayColumn: column,
    displayMatchLength: clampedMatchLength
  }
}

export function pushSearchMatch(args: {
  fileResult: SearchFileResult
  accumulator: SearchAccumulator
  lineContent: string
  matchStart: number
  matchLength: number
  lineNumber: number
  maxResults: number
}): 'continue' | 'stop' {
  const clamped = clampLineContext(args.lineContent, args.matchStart, args.matchLength)
  const match: SearchMatch = {
    line: args.lineNumber,
    column: clamped.column,
    matchLength: clamped.matchLength,
    lineContent: clamped.lineContent
  }
  if (clamped.displayColumn !== undefined) {
    match.displayColumn = clamped.displayColumn
  }
  if (clamped.displayMatchLength !== undefined) {
    match.displayMatchLength = clamped.displayMatchLength
  }
  args.fileResult.matches.push(match)
  args.fileResult.matchCount = (args.fileResult.matchCount ?? 0) + 1
  args.accumulator.totalMatches++
  if (args.accumulator.totalMatches >= args.maxResults) {
    args.accumulator.truncated = true
    return 'stop'
  }
  return 'continue'
}
