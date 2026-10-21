import type { Range } from '@tanstack/react-virtual'

export function getCombinedDiffRenderRange(
  range: Range,
  estimateHeight: (index: number) => number,
  viewportHeight: number
): number[] {
  let start = range.startIndex
  let end = range.endIndex
  const budget = Math.max(0, viewportHeight)
  let height = 0
  while (start > 0 && range.startIndex - start < range.overscan) {
    height += estimateHeight(start - 1)
    if (height > budget) {
      break
    }
    start -= 1
  }
  height = 0
  while (end + 1 < range.count && end - range.endIndex < range.overscan) {
    height += estimateHeight(end + 1)
    if (height > budget) {
      break
    }
    end += 1
  }
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
}
