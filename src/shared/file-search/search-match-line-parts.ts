import type { SearchMatch } from './code-search-types'

// Keep nearby context so long prefixes do not push the match out of view.
const BEFORE_MAX = 26

/** A result line split around its match, with the text before it trimmed to a little context. */
export function searchMatchLineParts(
  match: Pick<
    SearchMatch,
    'lineContent' | 'column' | 'matchLength' | 'displayColumn' | 'displayMatchLength'
  >
): { before: string; match: string; after: string } {
  const content = match.lineContent
  const col = (match.displayColumn ?? match.column) - 1
  const len = match.displayMatchLength ?? match.matchLength
  if (col >= 0 && col + len <= content.length) {
    const rawBefore = content.slice(0, col).trimStart()
    const before =
      rawBefore.length > BEFORE_MAX
        ? `…${rawBefore.slice(rawBefore.length - BEFORE_MAX)}`
        : rawBefore
    return { before, match: content.slice(col, col + len), after: content.slice(col + len) }
  }
  return { before: content, match: '', after: '' }
}
