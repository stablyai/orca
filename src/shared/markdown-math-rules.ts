// Chat math delimiter rules shared by desktop's micromark grammar and mobile's markdown-it rule.

/** Untrusted text: \href, \htmlClass and friends stay inert, and sizes/macro expansion are capped. */
export const MARKDOWN_MATH_KATEX_SETTINGS = {
  trust: false,
  maxSize: 20,
  maxExpand: 1000,
  strict: 'ignore'
} as const

/** `\(` is inline-only; `$$` and `\[` close with their mirror, `$` runs with an equal run. */
export function markdownMathCloser(opener: string): string {
  return opener === '\\[' ? '\\]' : opener === '\\(' ? '\\)' : opener
}

/** Only `$$+` and `\[` may display; `$` and `\(` always stay inline. */
export function isDisplayMathOpener(opener: string): boolean {
  return opener !== '$' && opener !== '\\('
}

/** TeX delimiter whitespace: ASCII space, tab and line endings; the end of the text counts too. */
export function isMathDelimiterSpace(char: string | undefined): boolean {
  return char === undefined || /^[ \t\r\n]$/.test(char)
}

/** A single `$` followed by whitespace (`$ 5`) never opens math. */
export function rejectsSingleDollarOpen(next: string | undefined): boolean {
  return isMathDelimiterSpace(next)
}

/** `$` and a number ending here is a price (`$5 or`, `$10;`, `$5?`), while `$5+2$` stays math. */
export function endsDollarAmount(next: string | undefined): boolean {
  return isMathDelimiterSpace(next) || (next !== undefined && '!):;?'.includes(next))
}

/** A single `$` closer after whitespace (`$5 + tax $`) or before a digit (`$3$4`) is no closer, so
 *  the opener stays text. Shell variables and prices (`$HOME and $PATH`) stay as written. */
export function rejectsSingleDollarClose(
  previous: string | undefined,
  next: string | undefined
): boolean {
  return isMathDelimiterSpace(previous) || (next !== undefined && next >= '0' && next <= '9')
}

/** `\[1, 2\]` is an escaped citation, not display math. */
export function isCitationBracketMath(opener: string, body: string): boolean {
  return opener === '\\[' && /^[\d\s,]+$/.test(body)
}
