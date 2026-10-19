// Why not localeCompare: Electron, the phone WebView and Node ship different ICU data, so the same
// sidebar must not order its text through a collator. Everything here is plain Unicode arithmetic.

const DIGIT_0 = 0x30
const DIGIT_9 = 0x39

function isAsciiDigit(code: number): boolean {
  return code >= DIGIT_0 && code <= DIGIT_9
}

const COMBINING_MARKS = /\p{M}/gu
const NON_ASCII = /[\u0080-\u{10ffff}]/u

/** Primary key: case and accents ignored, so "Éclair" sorts beside "eclair". */
function foldSidebarText(text: string): string {
  const lower = text.toLowerCase()
  return NON_ASCII.test(lower) ? lower.normalize('NFD').replace(COMBINING_MARKS, '') : lower
}

function codePointLength(code: number): number {
  return code > 0xffff ? 2 : 1
}

/** Code-point order; plain `<` on strings compares UTF-16 units, which misplaces astral characters. */
export function compareCodePoints(left: string, right: string): number {
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i) ?? 0
    const b = right.codePointAt(j) ?? 0
    if (a !== b) {
      return a < b ? -1 : 1
    }
    i += codePointLength(a)
    j += codePointLength(b)
  }
  return i < left.length ? 1 : j < right.length ? -1 : 0
}

function digitRunEnd(text: string, start: number): number {
  let end = start
  while (end < text.length && isAsciiDigit(text.charCodeAt(end))) {
    end++
  }
  return end
}

function skipLeadingZeros(text: string, start: number, end: number): number {
  let index = start
  while (index < end - 1 && text.charCodeAt(index) === DIGIT_0) {
    index++
  }
  return index
}

/** Digit runs compare as numbers ("w2" < "w10"); everything else by code point. */
function compareNatural(left: string, right: string): number {
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left.codePointAt(i) ?? 0
    const b = right.codePointAt(j) ?? 0
    if (isAsciiDigit(a) && isAsciiDigit(b)) {
      const leftEnd = digitRunEnd(left, i)
      const rightEnd = digitRunEnd(right, j)
      const leftStart = skipLeadingZeros(left, i, leftEnd)
      const rightStart = skipLeadingZeros(right, j, rightEnd)
      const lengthDelta = leftEnd - leftStart - (rightEnd - rightStart)
      if (lengthDelta !== 0) {
        return lengthDelta < 0 ? -1 : 1
      }
      // Same digit count without leading zeros, so digit-wise order is numeric order.
      const byDigits = compareCodePoints(
        left.slice(leftStart, leftEnd),
        right.slice(rightStart, rightEnd)
      )
      if (byDigits !== 0) {
        return byDigits
      }
      i = leftEnd
      j = rightEnd
      continue
    }
    if (a !== b) {
      return a < b ? -1 : 1
    }
    i += codePointLength(a)
    j += codePointLength(b)
  }
  return i < left.length ? 1 : j < right.length ? -1 : 0
}

function compareFoldedThenCanonical(
  left: string,
  right: string,
  fold: (text: string) => string
): number {
  if (left === right) {
    return 0
  }
  return (
    compareNatural(fold(left), fold(right)) ||
    // Why: "Alpha"/"alpha", "éclair"/"eclair" and "w02"/"w2" fold equal but must still order alike.
    compareCodePoints(left.normalize('NFC'), right.normalize('NFC'))
  )
}

/**
 * Device-independent order for sidebar text: case and accents ignored, digit runs by value, the
 * rest by code point; case and accents then break exact ties. Returns 0 only for canonically equal
 * text; callers break that tie by host-qualified id.
 */
export function compareSidebarText(left: string, right: string): number {
  return compareFoldedThenCanonical(left, right, foldSidebarText)
}

/** compareSidebarText that folds each string once; build one per sort, since the cache grows with it. */
export function createSidebarTextComparator(): (left: string, right: string) => number {
  const foldedByText = new Map<string, string>()
  const fold = (text: string): string => {
    let folded = foldedByText.get(text)
    if (folded === undefined) {
      folded = foldSidebarText(text)
      foldedByText.set(text, folded)
    }
    return folded
  }
  return (left, right) => compareFoldedThenCanonical(left, right, fold)
}
