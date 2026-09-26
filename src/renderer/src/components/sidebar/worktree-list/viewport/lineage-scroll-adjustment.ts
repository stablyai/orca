import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'

type SidebarVirtualizer = Virtualizer<HTMLDivElement, HTMLDivElement>

export type LineageScrollAdjustment = (
  groupKey: string,
  item: VirtualItem,
  delta: number,
  instance: SidebarVirtualizer
) => boolean

type OuterScrollAdjustmentOwner = {
  getVirtualItems: () => readonly VirtualItem[]
  itemSizeCache: ReadonlyMap<VirtualItem['key'], number>
  shouldAdjustScrollPositionOnItemSizeChange: SidebarVirtualizer['shouldAdjustScrollPositionOnItemSizeChange']
}

export function createLineageScrollAdjustment(
  outer: OuterScrollAdjustmentOwner
): LineageScrollAdjustment {
  return (groupKey, item, delta, instance) => {
    if (!outer.itemSizeCache.has(groupKey) || instance.scrollOffset === null) {
      return false
    }
    const group = outer.getVirtualItems().find((candidate) => candidate.key === groupKey)
    const scrollOffset = instance.scrollOffset + instance.scrollAdjustments
    // The outer row cannot anchor changes inside a group spanning the viewport.
    if (!group || group.start >= scrollOffset || group.end <= scrollOffset) {
      return false
    }
    return outer.shouldAdjustScrollPositionOnItemSizeChange?.(item, delta, instance) ?? false
  }
}
