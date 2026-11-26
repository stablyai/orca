export const NON_ASCII = /[\u0080-\u{10ffff}]/u

const isUpper = (code: number): boolean => code >= 65 && code <= 90
const isLower = (code: number): boolean => code >= 97 && code <= 122

/** Where camelCase words start; in ASCII each character keeps its offset in the lowercased path. */
export function asciiIdentifierBoundaries(searchPath: string): Set<number> | undefined {
  let boundaries: Set<number> | undefined
  for (let index = 1; index < searchPath.length; index++) {
    if (!isUpper(searchPath.charCodeAt(index))) {
      continue
    }
    const previous = searchPath.charCodeAt(index - 1)
    if (
      isLower(previous) ||
      (previous >= 48 && previous <= 57) ||
      (isUpper(previous) && isLower(searchPath.charCodeAt(index + 1)))
    ) {
      ;(boundaries ??= new Set()).add(index)
    }
  }
  return boundaries
}

export function unicodeIdentifierBoundaries(searchPath: string): Set<number> | undefined {
  const boundaries = new Set<number>()
  let lowerOffset = 0
  let segmentStart = 0
  for (let index = 0; index < searchPath.length; index++) {
    if (
      index > 0 &&
      /[A-Z]/.test(searchPath[index]) &&
      (/[a-z0-9]/.test(searchPath[index - 1]) ||
        (/[A-Z]/.test(searchPath[index - 1]) && /[a-z]/.test(searchPath[index + 1] ?? '')))
    ) {
      // Why: offsets index the NFC lowercase path (J + caron -> ǰ); ASCII never composes backwards.
      const segment = searchPath.slice(segmentStart, index)
      lowerOffset += NON_ASCII.test(segment)
        ? segment.toLowerCase().normalize('NFC').length
        : segment.length
      boundaries.add(lowerOffset)
      segmentStart = index
    }
  }
  return boundaries.size > 0 ? boundaries : undefined
}
