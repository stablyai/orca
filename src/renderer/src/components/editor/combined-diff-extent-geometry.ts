import type { VirtualItem } from '@tanstack/react-virtual'
import type { CombinedDiffItemAnchor } from './combined-diff-extent'

export function getCombinedDiffTopAnchor(
  items: readonly VirtualItem[],
  indices: ReadonlyMap<VirtualItem['key'], number>,
  position: number,
  height: number,
  priority?: VirtualItem['key']
): CombinedDiffItemAnchor | null {
  const priorityIndex = priority === undefined ? undefined : indices.get(priority)
  const focused = priorityIndex === undefined ? undefined : items[priorityIndex]
  let low = 0
  let high = items.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (items[middle]!.end <= position) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  const item =
    focused && focused.end > position && focused.start < position + height ? focused : items[low]
  return item
    ? {
        key: item.key,
        offset: Math.max(0, position - item.start),
        gap: Math.max(0, item.start - position)
      }
    : null
}
