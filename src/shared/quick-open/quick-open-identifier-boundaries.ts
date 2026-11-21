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
  for (let index = 0; index < searchPath.length; index++) {
    if (
      index > 0 &&
      /[A-Z]/.test(searchPath[index]) &&
      (/[a-z0-9]/.test(searchPath[index - 1]) ||
        (/[A-Z]/.test(searchPath[index - 1]) && /[a-z]/.test(searchPath[index + 1] ?? '')))
    ) {
      boundaries.add(lowerOffset)
    }
    lowerOffset += searchPath[index].toLowerCase().length
  }
  return boundaries.size > 0 ? boundaries : undefined
}
