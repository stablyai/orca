// Why: xterm gives each Brahmic spacing vowel sign (U+09BF, U+09CB, …) its own cell, matching
// wcwidth/string-width, so TUIs align on that count. WebGL then draws each cell in isolation and the
// font never reorders or composes the cluster. Joining the cluster's cells lets the browser shape it
// without changing the cell count.

const INDIC_SCAN_FLOOR = 0x0900
const INDIC_SCAN_CEILING = 0x0dff

// Why: Tamil pulli (U+0BCD) is omitted because it renders as a visible dot, so Tamil never forms conjuncts.
const VIRAMAS = '\\u094D\\u09CD\\u0A4D\\u0ACD\\u0B4D\\u0C4D\\u0CCD\\u0D4D\\u0DCA'

// Base letter, then marks/joiners, or a letter that follows a virama (+ optional ZWJ) as a conjunct.
// Malayalam virama + ZWJ is a legacy chillu, which ends its cluster instead of joining the next letter.
const INDIC_CLUSTER = new RegExp(
  `(?=\\p{L})[\\u0900-\\u0DFF](?:[\\p{M}\\u200C\\u200D]|(?<=[${VIRAMAS}]\\u200D?)(?<!\\u0D4D\\u200D)(?=\\p{L})[\\u0900-\\u0DFF])*`,
  'gu'
)
// Mn-only clusters (e.g. কু) already render in their single base cell.
const SPANS_MULTIPLE_CELLS = new RegExp(`\\p{Mc}|[${VIRAMAS}]\\u200D?\\p{L}`, 'u')

export function containsIndicScriptText(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    if (unit >= INDIC_SCAN_FLOOR && unit <= INDIC_SCAN_CEILING) {
      return true
    }
  }
  return false
}

/** Character-joiner handler: [start, end) ranges of Indic clusters that occupy more than one cell. */
export function findIndicClusterRanges(text: string): [number, number][] {
  // Why: xterm merges other joiners' results into this array in place, so it must be freshly allocated each call.
  const ranges: [number, number][] = []
  if (!containsIndicScriptText(text)) {
    return ranges
  }
  for (const match of text.matchAll(INDIC_CLUSTER)) {
    if (match[0].length > 1 && SPANS_MULTIPLE_CELLS.test(match[0])) {
      ranges.push([match.index, match.index + match[0].length])
    }
  }
  return ranges
}
