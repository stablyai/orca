const WORD_BOUNDARY_CHAR_RE = /^[\p{L}\p{N}]$/u
const CJK_BOUNDARY_CHAR_RE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u
const NO_SPACE_BEFORE_CHAR_RE = /^[,.;:!?%。，、！？；：）)\]}]$/u
const NO_SPACE_AFTER_CHAR_RE = /^[([{（《「『]$/u
const SPACE_AFTER_CHAR_RE = /^[,.;:!?%]$/u

function getFirstNonWhitespaceChar(text: string): string {
  return Array.from(text.trimStart())[0] ?? ''
}

function getLastNonWhitespaceChar(text: string): string {
  return Array.from(text.trimEnd()).at(-1) ?? ''
}

function shouldInsertSpaceBetweenFinalSegments(previousText: string, nextText: string): boolean {
  if (!previousText || !nextText || /\s$/.test(previousText) || /^\s/.test(nextText)) {
    return false
  }

  const previousChar = getLastNonWhitespaceChar(previousText)
  const nextChar = getFirstNonWhitespaceChar(nextText)
  if (!previousChar || !nextChar) {
    return false
  }
  if (
    CJK_BOUNDARY_CHAR_RE.test(previousChar) ||
    CJK_BOUNDARY_CHAR_RE.test(nextChar) ||
    NO_SPACE_BEFORE_CHAR_RE.test(nextChar) ||
    NO_SPACE_AFTER_CHAR_RE.test(previousChar)
  ) {
    return false
  }

  return (
    (WORD_BOUNDARY_CHAR_RE.test(previousChar) || SPACE_AFTER_CHAR_RE.test(previousChar)) &&
    WORD_BOUNDARY_CHAR_RE.test(nextChar)
  )
}

export function formatFinalTranscriptSegment(text: string, previousInsertedText: string): string {
  if (shouldInsertSpaceBetweenFinalSegments(previousInsertedText, text)) {
    return ` ${text}`
  }
  return text
}
