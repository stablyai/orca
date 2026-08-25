/**
 * Strip CJK (and other non-ASCII) letter runs that glue onto a file extension
 * in space-less languages. Agents and comments often write:
 *
 *   plans/foo.md로 확정했습니다.
 *   See `README.md에`
 *
 * English splits on spaces (`…md for`), but Korean/Japanese/Chinese particles
 * stay in the same token. ASCII Latin tails like `file.mdbackup` are kept —
 * only non-ASCII letters after an ASCII extension (and optional :line[:col])
 * count as trailing prose.
 *
 * Pair this with any `\p{L}` widening of path regexes: without the trim,
 * `…/파일.md로` would be swallowed whole (#13396 / #15240).
 */

const ASCII_EXT_THEN_NON_ASCII_LETTERS =
  /^(?<path>.*\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?)(?<prose>(?:(?![A-Za-z])\p{L})+)$/u

export function trimFileLinkTrailingNonAsciiLetters(text: string): string {
  const match = ASCII_EXT_THEN_NON_ASCII_LETTERS.exec(text)
  return match?.groups?.path ?? text
}

export function trimFileLinkRangeTrailingNonAsciiLetters<
  T extends { text: string; startIndex: number; endIndex: number }
>(range: T): T {
  const trimmed = trimFileLinkTrailingNonAsciiLetters(range.text)
  if (trimmed === range.text) {
    return range
  }
  return {
    ...range,
    text: trimmed,
    endIndex: range.startIndex + trimmed.length
  }
}
