const TRAILING_WHITESPACE_CHAR_RE = /\s/

// Why: `String.prototype.trimEnd` and the regex `\s` class cover the same
// WhiteSpace + LineTerminator set, so this reports `value.trimEnd().length`
// without allocating a trimmed copy.
function getTrimEndLength(value: string): number {
  let end = value.length
  while (end > 0 && TRAILING_WHITESPACE_CHAR_RE.test(value[end - 1])) {
    end -= 1
  }
  return end
}

/**
 * Whether an editor buffer still matches the content it was loaded from, using
 * the same comparison the dirty indicator has always used: exact for most
 * languages, trailing-whitespace-insensitive for markdown.
 *
 * Why not `normalize(a) !== normalize(b)`: that allocated two full copies of the
 * document on every keystroke. The trimmed lengths differ for almost every edit,
 * which settles the answer before any character comparison happens; the
 * remaining same-length case falls back to one native prefix compare.
 */
export function isEditorContentUnchanged(
  content: string,
  original: string,
  ignoreTrailingWhitespace: boolean
): boolean {
  if (!ignoreTrailingWhitespace) {
    return content === original
  }
  const originalEnd = getTrimEndLength(original)
  if (getTrimEndLength(content) !== originalEnd) {
    return false
  }
  return content.startsWith(
    originalEnd === original.length ? original : original.slice(0, originalEnd)
  )
}
