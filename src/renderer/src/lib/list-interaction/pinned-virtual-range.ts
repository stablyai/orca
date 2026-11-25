import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'

/** Add pinned indexes to the visible window without filling the gaps between them. */
export function extractPinnedVirtualRange(
  range: Range,
  pinnedIndexes: readonly (number | null | undefined)[]
): number[] {
  const indexes = defaultRangeExtractor(range)
  const extra = new Set<number>()
  for (const index of pinnedIndexes) {
    if (
      index !== null &&
      index !== undefined &&
      index >= 0 &&
      index < range.count &&
      !indexes.includes(index)
    ) {
      extra.add(index)
    }
  }
  if (extra.size === 0) {
    return indexes
  }
  return [...indexes, ...extra].sort((left, right) => left - right)
}
