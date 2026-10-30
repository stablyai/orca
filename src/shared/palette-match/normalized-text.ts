export type MatchRange = { start: number; end: number }

/** Fold case/Unicode with reverse offsets; omit tables when code-unit positions stay unchanged, as for ASCII. */
export type NormalizedText = {
  original: string
  normalized: string
  starts: Int32Array | null
  ends: Int32Array | null
}

const ASCII_FAST_PATH = /^[\t\n\v\f\r -~]*$/
// Fold tabs/newlines to space using a fixed-width class so the fast path preserves offsets.
const ASCII_CONTROL_SPACE = /[\t\n\v\f\r]/g
const COMBINING_MARK = /\p{M}/u
const UNICODE_SPACE = /\s/u

function isCombiningMark(codePoint: number): boolean {
  return COMBINING_MARK.test(String.fromCodePoint(codePoint))
}

function foldChunk(chunk: string): string {
  if (UNICODE_SPACE.test(chunk) && chunk.trim() === '') {
    return ' '
  }
  return chunk.normalize('NFC').toLowerCase()
}

/** Fold once; retain combining marks with their base so NFC ranges cannot split graphemes. */
export function normalizePaletteText(original: string): NormalizedText {
  if (ASCII_FAST_PATH.test(original)) {
    return {
      original,
      normalized: original.toLowerCase().replace(ASCII_CONTROL_SPACE, ' '),
      starts: null,
      ends: null
    }
  }

  let normalized = ''
  const starts: number[] = []
  const ends: number[] = []
  let identity = true
  let index = 0

  while (index < original.length) {
    const codePoint = original.codePointAt(index) as number
    let end = index + (codePoint > 0xffff ? 2 : 1)
    while (end < original.length) {
      const next = original.codePointAt(end) as number
      if (!isCombiningMark(next)) {
        break
      }
      end += next > 0xffff ? 2 : 1
    }

    const folded = foldChunk(original.slice(index, end))
    if (folded.length !== end - index) {
      identity = false
    }
    for (let offset = 0; offset < folded.length; offset += 1) {
      starts.push(index)
      ends.push(end)
    }
    normalized += folded
    index = end
  }

  if (identity) {
    return { original, normalized, starts: null, ends: null }
  }
  return { original, normalized, starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
}

export function mapNormalizedRange(text: NormalizedText, start: number, end: number): MatchRange {
  if (end <= start) {
    return { start: 0, end: 0 }
  }
  if (!text.starts || !text.ends) {
    return { start, end }
  }
  const clampedStart = Math.max(0, Math.min(start, text.normalized.length - 1))
  const clampedEnd = Math.max(clampedStart, Math.min(end, text.normalized.length) - 1)
  return { start: text.starts[clampedStart], end: text.ends[clampedEnd] }
}

export function mergeMatchRanges(ranges: readonly MatchRange[]): MatchRange[] {
  if (ranges.length <= 1) {
    return [...ranges]
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: MatchRange[] = [{ ...sorted[0] }]
  for (const range of sorted.slice(1)) {
    const last = merged.at(-1) as MatchRange
    if (range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}
