import type { SearchMatch } from '../../../../../../shared/file-search/code-search-types'

const BEFORE_MATCH_MAX_CHARS = 26

export type SearchMatchPreviewParts = { before: string; match: string; after: string }

/** Keeps nearby context so long prefixes do not push the match out of view. */
export function getSearchMatchPreviewParts(match: SearchMatch): SearchMatchPreviewParts {
  const content = match.lineContent
  const col = (match.displayColumn ?? match.column) - 1
  const len = match.displayMatchLength ?? match.matchLength
  if (col >= 0 && col + len <= content.length) {
    const rawBefore = content.slice(0, col).trimStart()
    const before =
      rawBefore.length > BEFORE_MATCH_MAX_CHARS
        ? `…${rawBefore.slice(rawBefore.length - BEFORE_MATCH_MAX_CHARS)}`
        : rawBefore
    return { before, match: content.slice(col, col + len), after: content.slice(col + len) }
  }
  return { before: content, match: '', after: '' }
}
