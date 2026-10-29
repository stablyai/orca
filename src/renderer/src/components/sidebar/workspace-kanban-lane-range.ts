import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'

export function extractWorkspaceKanbanLaneRange(
  range: Range,
  focusedIndex: number | null
): number[] {
  const indexes = defaultRangeExtractor(range)
  if (
    focusedIndex === null ||
    focusedIndex < 0 ||
    focusedIndex >= range.count ||
    indexes.includes(focusedIndex)
  ) {
    return indexes
  }
  return [...indexes, focusedIndex].sort((left, right) => left - right)
}
