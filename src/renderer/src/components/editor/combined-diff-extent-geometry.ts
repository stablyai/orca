import type { VirtualItem } from '@tanstack/react-virtual'
import type {
  CombinedDiffExtentItem,
  CombinedDiffItemAnchor,
  CombinedDiffViewImport
} from './combined-diff-extent'

export function combinedDiffItemsChanged(
  items: readonly CombinedDiffExtentItem[],
  previousItems: readonly CombinedDiffExtentItem[],
  prefix: number
): boolean {
  return (
    items.length !== previousItems.length ||
    items.some((item, index) => {
      const previous = previousItems[index]
      return (
        !previous ||
        item.key !== previous.key ||
        item.size !== previous.size ||
        item.settled !== previous.settled ||
        item.contentGeneration !== previous.contentGeneration ||
        item.start + prefix !== previous.start
      )
    })
  )
}

export function getCombinedDiffSurvivingAnchor(
  anchor: CombinedDiffItemAnchor | null,
  items: readonly CombinedDiffExtentItem[],
  indices: ReadonlyMap<VirtualItem['key'], number>
): CombinedDiffItemAnchor | null {
  const fallback =
    anchor && !indices.has(anchor.key)
      ? items
          .slice(items.findIndex((item) => item.key === anchor.key) + 1)
          .find((item) => indices.has(item.key))
      : undefined
  return anchor && indices.has(anchor.key)
    ? anchor
    : fallback
      ? { key: fallback.key, offset: 0, gap: anchor?.gap ?? 0 }
      : null
}

export function getCombinedDiffViewExport(
  items: readonly VirtualItem[],
  anchor: CombinedDiffItemAnchor | null,
  index: number,
  scrollTop: number,
  leading: number,
  height: number
): CombinedDiffViewImport {
  const item = items[index]
  const position = scrollTop - leading
  const fallbackKeys: string[] = []
  for (let next = index + 1; next < items.length; next += 1) {
    const candidate = items[next]!
    if (candidate.start >= position + height) {
      break
    }
    fallbackKeys.push(String(candidate.key))
  }
  return {
    scrollTop,
    anchor:
      anchor && item && typeof anchor.key === 'string'
        ? { key: anchor.key, offset: position - item.start, fallbackKeys }
        : null
  }
}

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
