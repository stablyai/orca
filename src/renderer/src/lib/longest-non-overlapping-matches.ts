/** Keeps the longest of any overlapping matches, returned in start order. */
export function preferLongestNonOverlappingMatches<T>(
  matches: readonly T[],
  options: {
    length: (match: T) => number
    overlaps: (left: T, right: T) => boolean
    compareStart: (left: T, right: T) => number
  }
): T[] {
  const selected: T[] = []
  const byLengthDescending = [...matches].sort(
    (a, b) => options.length(b) - options.length(a) || options.compareStart(a, b)
  )
  for (const match of byLengthDescending) {
    if (!selected.some((existing) => options.overlaps(existing, match))) {
      selected.push(match)
    }
  }
  return selected.sort(options.compareStart)
}
