import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual'

/**
 * The virtualizer's range plus one pinned index, so a focused or active item
 * stays mounted while scrolled out of view — a keyboard-focused lane, or the
 * session-grid card holding the keyboard.
 */
export function extractVirtualRangeWithFocusedIndex(
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
