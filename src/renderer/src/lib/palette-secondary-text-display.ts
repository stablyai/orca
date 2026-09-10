import type { MatchRange } from './palette-match/normalized-text'

/**
 * The search engine reports whichever secondary field matched, which for an
 * editor tab may be the absolute path (`/Users/…/repo/src/app.ts`) even though
 * the row normally shows the relative one. When the display text is a suffix of
 * the matched text and every hit lands inside that suffix, show the short form
 * with re-based ranges; otherwise the long form is the only honest evidence.
 */
export function preferDisplaySecondaryText({
  displayText,
  matchedText,
  ranges
}: {
  displayText: string
  matchedText: string
  ranges: readonly MatchRange[]
}): { text: string; ranges: readonly MatchRange[] } {
  if (matchedText === displayText || displayText.length === 0) {
    return { text: matchedText, ranges }
  }
  if (!matchedText.endsWith(displayText)) {
    return { text: matchedText, ranges }
  }
  const offset = matchedText.length - displayText.length
  if (ranges.some((range) => range.start < offset)) {
    return { text: matchedText, ranges }
  }
  return {
    text: displayText,
    ranges: ranges.map((range) => ({ start: range.start - offset, end: range.end - offset }))
  }
}
