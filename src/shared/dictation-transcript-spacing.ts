/** Blocks that bound a rich-text caret's neighbours, so a new paragraph's start has none. */
export const DICTATION_TEXT_BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, div'

// Chinese and Japanese don't space words or after their full-width punctuation; Korean does, so Hangul spaces like Latin text.
const UNSPACED_SCRIPT_CHAR_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3000-\u303f\u30fb\u30fc\uff00-\uff9f\uffe0-\uffef]$/u
const NO_SPACE_BEFORE_CHAR_RE =
  /^[,.;:!?%\u3002\uff0c\u3001\uff01\uff1f\uff1b\uff1a\uff09)\]}\u201d\u2019\u00bb]$/u
const NO_SPACE_AFTER_CHAR_RE = /^[([{\uff08\u300a\u300c\u300e\u201c\u2018\u00ab\u201e]$/u
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

// Dictated text and its neighbour touch with no space between: one is empty or already spaced, either is Chinese or Japanese, or punctuation binds them.
function dictationJoinsWithoutSpace(previousText: string, nextText: string): boolean {
  if (!previousText || !nextText || /\s$/.test(previousText) || /^\s/.test(nextText)) {
    return true
  }
  const previousChar = getLastChar(previousText)
  const nextChar = getFirstChar(nextText)
  return (
    UNSPACED_SCRIPT_CHAR_RE.test(previousChar) ||
    UNSPACED_SCRIPT_CHAR_RE.test(nextChar) ||
    NO_SPACE_BEFORE_CHAR_RE.test(nextChar) ||
    NO_SPACE_AFTER_CHAR_RE.test(previousChar)
  )
}

/** `before` and `text` joined with the space dictation puts between them, if any. */
export function appendDictationText(before: string, text: string): string {
  return `${before}${dictationSeparators(before, text, '').leading}${text}`
}

/** The spaces dictated text needs between the text before and after where it lands, unless punctuation, Chinese or Japanese, or a quote it sits just inside joins them. */
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
