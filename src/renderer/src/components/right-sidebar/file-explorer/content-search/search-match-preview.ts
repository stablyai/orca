import type { SearchMatch } from '../../../../../../shared/file-search/code-search-types'

/** Lines whose text up to the match end fits a 220px sidebar keep their start. */
const FULL_PREFIX_MAX_CHARS = 26
const CONTEXT_MAX_CHARS = 12
// Letters, marks and digits of every script are word characters, except emoji variation
// selectors and scripts written without spaces between words, where skipping to the next
// word start would drop the whole phrase.
const NON_WORD_EXCEPTIONS = String.raw`[\uFE0E\uFE0F\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Bopo}\p{scx=Yiii}\p{scx=Tang}\p{scx=Nshu}\p{scx=Kits}\p{scx=Thai}\p{scx=Laoo}\p{scx=Khmr}\p{scx=Mymr}\p{scx=Lana}\p{scx=Tale}\p{scx=Talu}\p{scx=Tavt}\p{scx=Ahom}\p{scx=Java}\p{scx=Bali}\p{scx=Bugi}]`
const WORD = String.raw`(?!${NON_WORD_EXCEPTIONS})[\p{L}\p{Mn}\p{Mc}\p{N}_$]`
const NON_WORD = String.raw`${NON_WORD_EXCEPTIONS}|[^\p{L}\p{Mn}\p{Mc}\p{N}_$]`
const WORD_END = new RegExp(`${WORD}$`, 'u')
const WORD_START = new RegExp(`(?<=${NON_WORD})${WORD}`, 'u')
const LOW_SURROGATE_START = /^[\udc00-\udfff]/
const LEADING_MARKS = /^\p{M}+/u

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
  let tail = before.slice(-CONTEXT_MAX_CHARS)
  // A cut through an emoji or other astral character would open on a lone surrogate (U+FFFD).
  if (LOW_SURROGATE_START.test(tail)) {
    tail = tail.slice(1)
  }
  // Start at a word boundary so context never opens on a word fragment. The last code
  // point before the cut may be a surrogate pair.
  const cutsWord = WORD_END.test(before.slice(-tail.length - 2, -tail.length))
  const boundary = cutsWord ? tail.search(WORD_START) : -1
  const context = boundary === -1 ? tail : tail.slice(boundary)
  // A decomposed accent cut from its letter would sit on the ellipsis.
  return { before: `…${context.replace(LEADING_MARKS, '')}`, ...parts }
}
