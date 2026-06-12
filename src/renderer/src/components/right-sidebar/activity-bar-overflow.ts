import type { ActiveRightSidebarTab } from '@/store/slices/editor'

const TOP_ACTIVITY_BUTTON_WIDTH = 36
const TOP_ACTIVITY_MORE_BUTTON_WIDTH = 32

export function getTopActivityBarLayout<T extends { id: ActiveRightSidebarTab }>(
  items: readonly T[],
  availableWidth: number | null,
  activeId: ActiveRightSidebarTab
): { visibleItems: T[]; overflowItems: T[] } {
  if (!availableWidth || !Number.isFinite(availableWidth)) {
    return { visibleItems: [...items], overflowItems: [] }
  }
  if (items.length * TOP_ACTIVITY_BUTTON_WIDTH <= availableWidth) {
    return { visibleItems: [...items], overflowItems: [] }
  }

  const visibleCount = Math.max(
    1,
    Math.min(
      items.length - 1,
      Math.floor((availableWidth - TOP_ACTIVITY_MORE_BUTTON_WIDTH) / TOP_ACTIVITY_BUTTON_WIDTH)
    )
  )
  const visibleItems = items.slice(0, visibleCount)
  const activeItem = items.find((item) => item.id === activeId)
  if (activeItem && !visibleItems.some((item) => item.id === activeItem.id)) {
    visibleItems[visibleItems.length - 1] = activeItem
  }

  const visibleIds = new Set(visibleItems.map((item) => item.id))
  return {
    visibleItems,
    overflowItems: items.filter((item) => !visibleIds.has(item.id))
  }
}
