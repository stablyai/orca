// Why: autolinkers only know ASCII punctuation, so Japanese prose that hugs a
// URL (`（https://…/pull/1078）。`, `「https://…」を見て`) ends up inside the href.
// Full-width punctuation never appears unencoded in a real URL, but CJK *text*
// legitimately does, so only `\p{P}\p{S}\p{Z}` terminate a URL.

// An ASCII character xterm's default URL regex allows inside a URL body.
const ASCII_URL_BODY = `(?=\\p{ASCII})[^\\s"'!*(){}|\\\\^<>\`]`
// Same, minus the characters prose puts after a URL rather than inside one.
const ASCII_URL_END = `(?=\\p{ASCII})[^\\s"':,.!?{}|\\\\^~\\[\\]\`()<>]`
// Any non-ASCII character that is not punctuation, a symbol, or a separator.
const NON_ASCII_URL_CHAR = `(?![\\p{P}\\p{S}\\p{Z}])\\P{ASCII}`

/**
 * Drop-in replacement for the default `urlRegex` of xterm's web-links addon.
 * Same shape as the upstream default, with the non-ASCII rule added.
 */
export const TERMINAL_HTTP_URL_PATTERN = new RegExp(
  `(?:https?|HTTPS?):[/]{2}(?:${ASCII_URL_BODY}|${NON_ASCII_URL_CHAR})*(?:${ASCII_URL_END}|${NON_ASCII_URL_CHAR})`,
  'u'
)

const NON_ASCII_URL_TERMINATOR = /(?=\P{ASCII})[\p{P}\p{S}\p{Z}]/u
// GFM's own autolink trailing set; `)` is handled separately by paren balance.
const ASCII_TRAILING_PUNCTUATION = /[?!.,:*_~'"]+$/

/**
 * Trims prose punctuation that an autolinker left on the end of a URL. Mirrors
 * GFM's trailing-punctuation rules (including its unbalanced-`)` rule, which
 * keeps `…/wiki/Foo_(bar)` whole) and additionally cuts at the first non-ASCII
 * punctuation, which GFM does not recognise.
 */
export function trimUrlTrailingPunctuation(url: string): string {
  const terminator = url.search(NON_ASCII_URL_TERMINATOR)
  let trimmed = terminator === -1 ? url : url.slice(0, terminator)
  for (;;) {
    const next = trimmed.replace(ASCII_TRAILING_PUNCTUATION, '')
    if (next.endsWith(')') && countChar(next, ')') > countChar(next, '(')) {
      trimmed = next.slice(0, -1)
      continue
    }
    if (next === trimmed) {
      return trimmed
    }
    trimmed = next
  }
}

function countChar(value: string, char: string): number {
  let count = 0
  for (const current of value) {
    if (current === char) {
      count += 1
    }
  }
  return count
}
