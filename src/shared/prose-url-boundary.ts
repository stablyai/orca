// Why not all non-ascii punctuation: titles keep `・`, `–` and `·` unencoded in a url
// (`/wiki/ジョン・スミス`), so only brackets, quotes, spaces and sentence marks end one.
const PROSE_URL_TERMINATOR_SOURCE = String.raw`(?![\0-\x7f])[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Z}、。，．！？：；｡､…‥—]`

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
