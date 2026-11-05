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

/** A single `$` followed by whitespace is money or prose (`$ 5`), never an opener. */
export function rejectsSingleDollarOpen(next: string | undefined): boolean {
  return next === undefined || /^[ \t\r\n]$/.test(next)
}

/** Prices stay text: `$10 and $20`, `$5 each`, `$3$4`; operators or TeX make it math. */
export function rejectsSingleDollarClose(body: string, closerFollowedByDigit: boolean): boolean {
  return (
    /\s/.test(body.at(-1) ?? '') ||
    closerFollowedByDigit ||
    (/^[+-]?\d[\d,]*(?:\.\d+)?(?:[^\p{ASCII}]|\s)/u.test(body) && !/[\\_^=<>+*/{}-]/.test(body))
  )
}

/** `\[1, 2\]` is an escaped citation, not display math. */
export function isCitationBracketMath(opener: string, body: string): boolean {
  return opener === '\\[' && /^[\d\s,]+$/.test(body)
}
