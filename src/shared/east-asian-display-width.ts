/**
 * Why: Hangul, CJK, and kana each occupy two terminal columns but a single
 * UTF-16 code unit, so `String.prototype.padEnd` — which counts code units —
 * leaves column-aligned CLI and SSH tables ragged once a name is not Latin.
 * `terminal-unicode-provider` cannot serve these call sites: it wraps an
 * xterm `IUnicodeVersionProvider`, which needs a live terminal instance, while
 * these tables are rendered by the CLI and the SSH main process.
 *
 * The ranges below are the Wide and Fullwidth blocks of Unicode
 * East_Asian_Width, plus the zero-width combining ranges that would otherwise
 * be over-counted. This is a pragmatic subset covering the scripts these
 * tables actually carry, not a complete East_Asian_Width implementation.
 */

type CodePointRange = readonly [start: number, end: number]

const DOUBLE_WIDTH_RANGES: readonly CodePointRange[] = [
  [0x1100, 0x115f], // Hangul Jamo — initial consonants
  [0x2e80, 0x303e], // CJK Radicals Supplement … CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana, Katakana, Bopomofo, Hangul Compatibility Jamo
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi Syllables and Radicals
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical Forms
  [0xfe30, 0xfe6f], // CJK Compatibility Forms, Small Form Variants
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth currency and bar signs
  [0x1f300, 0x1f64f], // Miscellaneous Symbols and Pictographs, Emoticons
  [0x1f680, 0x1f6ff], // Transport and Map Symbols
  [0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
  [0x20000, 0x3fffd] // CJK Unified Ideographs Extension B and later
]

const ZERO_WIDTH_RANGES: readonly CodePointRange[] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x200b, 0x200f], // Zero-width space through the bidi marks
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B — conjoining medials and finals
  [0xfe00, 0xfe0f], // Variation Selectors
  [0xfeff, 0xfeff] // Zero-width no-break space (BOM)
]

function isInRanges(codePoint: number, ranges: readonly CodePointRange[]): boolean {
  return ranges.some(([start, end]) => codePoint >= start && codePoint <= end)
}

function codePointDisplayWidth(codePoint: number): 0 | 1 | 2 {
  // Why: C0/C1 controls advance the cursor by their own escape semantics, not
  // by a column, so counting them would over-pad every row that carries one.
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
    return 0
  }
  if (isInRanges(codePoint, ZERO_WIDTH_RANGES)) {
    return 0
  }
  return isInRanges(codePoint, DOUBLE_WIDTH_RANGES) ? 2 : 1
}

/** Terminal columns `text` occupies, counting Hangul/CJK/kana as two. */
export function getEastAsianDisplayWidth(text: string): number {
  let width = 0
  // Why: iterating the string yields whole code points, so an astral character
  // is measured once instead of twice as its surrogate halves.
  for (const character of text) {
    width += codePointDisplayWidth(character.codePointAt(0) ?? 0)
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
