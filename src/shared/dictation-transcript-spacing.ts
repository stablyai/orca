const CJK_BOUNDARY_CHAR_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u
const NO_SPACE_BEFORE_CHAR_RE = /^[,.;:!?%。，、！？；：）)\]}”’»]$/u
const NO_SPACE_AFTER_CHAR_RE = /^[([{（《「『“‘«„]$/u
const STRAIGHT_QUOTE_RE = /["'`]/
// A straight quote opens after a space or the start, and closes before a space, punctuation or the end; anything else is an apostrophe.
const opensQuote = (before: string): boolean => /(^|[\s([{])["'`]$/.test(before)
const closesQuote = (after: string): boolean => /^["'`]([^\p{L}\p{N}]|$)/u.test(after)

// Two code units hold the edge code point; callers have already ruled out edge whitespace.
function getFirstChar(text: string): string {
  return Array.from(text.slice(0, 2))[0] ?? ''
}

function getLastChar(text: string): string {
  return Array.from(text.slice(-2)).at(-1) ?? ''
}

// Dictated text and its neighbour touch with no space between: one is empty or already spaced, either is CJK, or punctuation binds them.
function dictationJoinsWithoutSpace(previousText: string, nextText: string): boolean {
  if (!previousText || !nextText || /\s$/.test(previousText) || /^\s/.test(nextText)) {
    return true
  }
  const previousChar = getLastChar(previousText)
  const nextChar = getFirstChar(nextText)
  return (
    CJK_BOUNDARY_CHAR_RE.test(previousChar) ||
    CJK_BOUNDARY_CHAR_RE.test(nextChar) ||
    NO_SPACE_BEFORE_CHAR_RE.test(nextChar) ||
    NO_SPACE_AFTER_CHAR_RE.test(previousChar)
  )
}

/** The spaces dictated text needs between the text before and after where it lands, unless punctuation, CJK or a quote it sits just inside joins them. */
export function dictationSeparators(
  before: string,
  text: string,
  after: string
): { leading: string; trailing: string } {
  const opened = opensQuote(before.slice(-2))
  const closed = closesQuote(after) && STRAIGHT_QUOTE_RE.test(before)
  return {
    leading: opened || dictationJoinsWithoutSpace(before, text) ? '' : ' ',
    trailing: closed || dictationJoinsWithoutSpace(text, after) ? '' : ' '
  }
}
