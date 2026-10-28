// Why not all non-ascii punctuation: titles keep `・`, `–` and `·` unencoded in a url
// (`/wiki/ジョン・スミス`), so only brackets, quotes, spaces and sentence marks end one.
// Escaped CJK sentence marks 、。，．！？：；｡､…‥— keep this module's chunk one-byte in V8.
const PROSE_URL_TERMINATOR_SOURCE = String.raw`(?![\0-\x7f])[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Z}\u3001\u3002\uFF0C\uFF0E\uFF01\uFF1F\uFF1A\uFF1B\uFF61\uFF64\u2026\u2025\u2014]`

const NOT_PROSE_URL_TERMINATOR = `(?!${PROSE_URL_TERMINATOR_SOURCE})`

/** xterm's default web-links url pattern, also ended by prose punctuation; needs the `u` flag. */
export const PROSE_HTTP_URL_SOURCE =
  String.raw`https?:\/\/(?:${NOT_PROSE_URL_TERMINATOR}[^\s"'!*(){}|\\^<>\x60])*` +
  String.raw`${NOT_PROSE_URL_TERMINATOR}[^\s"':,.!?{}|\\^~\[\]\x60()<>]`

const PROSE_URL_TERMINATOR = new RegExp(PROSE_URL_TERMINATOR_SOURCE, 'u')
const PROSE_URL_END = new RegExp(String.raw`\s|${PROSE_URL_TERMINATOR_SOURCE}`, 'u')
const PROSE_URL_TERMINATOR_RUN = new RegExp(`((?:${PROSE_URL_TERMINATOR_SOURCE})+)`, 'u')

export function isProseUrlTerminator(char: string): boolean {
  return PROSE_URL_TERMINATOR.test(char)
}

/** Index of the first whitespace or terminator, where a url starting the text ends, or -1. */
export function findProseUrlEnd(text: string): number {
  return text.search(PROSE_URL_END)
}

/** The text cut around each run of terminators; odd entries are the runs. */
export function splitAtProseUrlTerminators(text: string): string[] {
  return text.split(PROSE_URL_TERMINATOR_RUN)
}
