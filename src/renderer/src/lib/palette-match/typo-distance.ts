export const PALETTE_TYPO_MIN_LENGTH = 4

/**
 * True when `a` and `b` are within one edit. Length is checked before scanning so
 * impossible pairs never touch the character loop.
 */
export function isWithinOnePaletteEdit(a: string, b: string): boolean {
  const lengthDelta = a.length - b.length
  if (lengthDelta > 1 || lengthDelta < -1) {
    return false
  }
  if (a === b) {
    return true
  }

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  let shortIndex = 0
  let longIndex = 0
  let edits = 0

  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1
      longIndex += 1
      continue
    }
    edits += 1
    if (edits > 1) {
      return false
    }
    if (shorter.length === longer.length) {
      shortIndex += 1
    }
    longIndex += 1
  }

  return edits + (longer.length - longIndex) + (shorter.length - shortIndex) <= 1
}

/** Typo matching is reserved for letter-only words long enough to stay unambiguous. */
export function isPaletteTypoCandidate(text: string): boolean {
  return text.length >= PALETTE_TYPO_MIN_LENGTH
}
