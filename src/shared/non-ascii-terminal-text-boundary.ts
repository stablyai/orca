/**
 * Non-ASCII boundary rules for terminal autolink spans (#15240).
 *
 * URLs stop at non-ASCII punctuation but keep CJK letters inside the path. File
 * links mirror that: anything glued after an ASCII extension is trailing prose.
 */

// Why not all non-ascii: a url path may legitimately carry unencoded CJK.
export const NON_ASCII_PROSE_BOUNDARY = /[\p{P}\p{S}\p{Z}]/u

export function isNonAsciiProseBoundary(code: number): boolean {
  return code > 0x7e && NON_ASCII_PROSE_BOUNDARY.test(String.fromCharCode(code))
}

// Why \P{ASCII} and not a letter run: a real path continues in ASCII after the
// extension, and a letters-only trim never fires on `foo.mdを(参照)` (#10573 review).
const ASCII_EXT_THEN_NON_ASCII =
  /^(?<path>.*\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?)(?<prose>\P{ASCII}[\s\S]*)$/u

export function trimFileLinkTrailingNonAsciiProse(text: string): string {
  const match = ASCII_EXT_THEN_NON_ASCII.exec(text)
  return match?.groups?.path ?? text
}

// Why only before an ASCII start: `참고파일.md` may genuinely be a file name, so a
// leading non-ASCII run is prose only when the path resumes in ASCII (`참고docs/x.md`).
const LEADING_NON_ASCII_THEN_ASCII = /^(?<prose>\P{ASCII}+)(?<path>[A-Za-z0-9_][\s\S]*)$/u

export function trimFileLinkLeadingNonAsciiProse(text: string): string {
  return LEADING_NON_ASCII_THEN_ASCII.exec(text)?.groups?.path ?? text
}

export function trimFileLinkNonAsciiProse(text: string): string {
  return trimFileLinkTrailingNonAsciiProse(trimFileLinkLeadingNonAsciiProse(text))
}

export function trimFileLinkRangeLeadingNonAsciiProse<
  T extends { text: string; startIndex: number; endIndex: number }
>(range: T): T {
  const trimmed = trimFileLinkLeadingNonAsciiProse(range.text)
  if (trimmed === range.text) {
    return range
  }
  return { ...range, text: trimmed, startIndex: range.endIndex - trimmed.length }
}

export function trimFileLinkRangeNonAsciiProse<
  T extends { text: string; startIndex: number; endIndex: number }
>(range: T): T {
  return trimFileLinkRangeTrailingNonAsciiProse(trimFileLinkRangeLeadingNonAsciiProse(range))
}

export function trimFileLinkRangeTrailingNonAsciiProse<
  T extends { text: string; startIndex: number; endIndex: number }
>(range: T): T {
  const trimmed = trimFileLinkTrailingNonAsciiProse(range.text)
  if (trimmed === range.text) {
    return range
  }
  return {
    ...range,
    text: trimmed,
    endIndex: range.startIndex + trimmed.length
  }
}
