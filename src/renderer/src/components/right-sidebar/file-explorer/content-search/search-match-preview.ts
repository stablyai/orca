import type { SearchMatch } from '../../../../../../shared/file-search/code-search-types'

/** Lines whose text up to the match end fits a 220px sidebar keep their start. */
const FULL_PREFIX_MAX_CHARS = 26
const CONTEXT_MAX_CHARS = 12

export type SearchMatchPreviewParts = { before: string; match: string; after: string }

/** Keeps the match in view: the whole line start when it fits, else a few words of context after an ellipsis. */
export function getSearchMatchPreviewParts(match: SearchMatch): SearchMatchPreviewParts {
  const content = match.lineContent
  const col = (match.displayColumn ?? match.column) - 1
  const len = match.displayMatchLength ?? match.matchLength
  if (col < 0 || col + len > content.length) {
    return { before: content.trimStart(), match: '', after: '' }
  }
  const before = content.slice(0, col).trimStart()
  const parts = { match: content.slice(col, col + len), after: content.slice(col + len) }
  if (before.length + len <= FULL_PREFIX_MAX_CHARS) {
    return { before, ...parts }
  }
  if (before.length <= CONTEXT_MAX_CHARS) {
    return { before, ...parts }
  }
  const tail = before.slice(-CONTEXT_MAX_CHARS)
  // Start at a word boundary so context never opens on a word fragment.
  const boundary = tail.search(/[^\w$][\w$]/)
  const startsOnWord = /[^\w$]/.test(before.charAt(before.length - tail.length - 1))
  const context = startsOnWord ? tail : boundary === -1 ? tail : tail.slice(boundary + 1)
  return { before: `…${context}`, ...parts }
}
