import {
  DOUBLE_WIDTH_CODE_POINT_RANGES,
  ZERO_WIDTH_CODE_POINT_RANGES
} from './east-asian-display-width-table'

/**
 * Why: Hangul, CJK, and kana each occupy two terminal columns but a single
 * UTF-16 code unit, so `String.prototype.padEnd` — which counts code units —
 * leaves column-aligned CLI and SSH tables ragged once a name is not Latin.
 * `terminal-unicode-provider` cannot serve these call sites: it wraps an xterm
 * `IUnicodeVersionProvider`, which needs a live terminal instance, while these
 * tables render in the CLI and the SSH main process.
 *
 * The width table is generated from that same xterm provider rather than
 * hand-maintained, so these tables cannot disagree with what the terminal
 * renders. See config/scripts/generate-east-asian-display-width-table.mjs.
 */

const ZERO_WIDTH_JOINER = 0x200d

function isInRanges(codePoint: number, ranges: readonly number[]): boolean {
  let low = 0
  let high = ranges.length / 2 - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (codePoint < ranges[middle * 2]) {
      high = middle - 1
    } else if (codePoint > ranges[middle * 2 + 1]) {
      low = middle + 1
    } else {
      return true
    }
  }
  return false
}

function codePointDisplayWidth(codePoint: number): 0 | 1 | 2 {
  if (isInRanges(codePoint, ZERO_WIDTH_CODE_POINT_RANGES)) {
    return 0
  }
  return isInRanges(codePoint, DOUBLE_WIDTH_CODE_POINT_RANGES) ? 2 : 1
}

/**
 * Terminal columns `text` occupies, counting Hangul/CJK/kana as two and
 * collapsing ZWJ emoji sequences to the single glyph a terminal draws.
 */
export function getEastAsianDisplayWidth(text: string): number {
  let width = 0
  let previousWidth = 0
  let joinedByZeroWidthJoiner = false
  // Why: iterating the string yields whole code points, so an astral character
  // is measured once instead of twice as its surrogate halves.
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === ZERO_WIDTH_JOINER) {
      joinedByZeroWidthJoiner = previousWidth > 0
      continue
    }
    const characterWidth = codePointDisplayWidth(codePoint)
    if (joinedByZeroWidthJoiner && characterWidth > 0) {
      // Why: mirrors terminal-unicode-provider's orca-11-zwj rule — a ZWJ
      // sequence renders as one glyph and budgets as one wide cell pair, so the
      // joined half must not advance the column count again.
      joinedByZeroWidthJoiner = false
      continue
    }
    joinedByZeroWidthJoiner = false
    width += characterWidth
    if (characterWidth > 0) {
      previousWidth = characterWidth
    }
  }
  return width
}

/**
 * Display-width-aware `padEnd`. Like the built-in, it never truncates: text
 * already at or past `targetWidth` is returned unchanged.
 */
export function padEndToEastAsianDisplayWidth(text: string, targetWidth: number): string {
  const padding = targetWidth - getEastAsianDisplayWidth(text)
  return padding > 0 ? text + ' '.repeat(padding) : text
}
