const TRAILING_WHITESPACE_CHAR_RE = /\s/

// Regex whitespace matches trimEnd’s character set; count it without allocating a trimmed copy.
function getTrimEndLength(value: string): number {
  let end = value.length
  while (end > 0 && TRAILING_WHITESPACE_CHAR_RE.test(value[end - 1])) {
    end -= 1
  }
  return end
}

/** Compare exactly except Markdown trailing whitespace; length checks and native prefix comparison avoid per-keystroke normalized document copies. */
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
