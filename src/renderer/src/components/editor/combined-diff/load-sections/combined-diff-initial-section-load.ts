export const COMBINED_DIFF_INITIAL_SECTION_LOAD_COUNT = 6

export function getInitialCombinedDiffSectionLoadIndices({
  sectionCount,
  loadedIndices,
  maxCount = COMBINED_DIFF_INITIAL_SECTION_LOAD_COUNT
}: {
  sectionCount: number
  loadedIndices: ReadonlySet<number>
  maxCount?: number
}): number[] {
  const limit = Math.max(0, Math.min(sectionCount, maxCount))
  const indices: number[] = []

  for (let index = 0; index < limit; index += 1) {
    if (!loadedIndices.has(index)) {
      indices.push(index)
    }
  }

  return indices
}
