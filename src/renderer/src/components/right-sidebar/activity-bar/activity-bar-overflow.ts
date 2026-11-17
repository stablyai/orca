import type { ActiveRightSidebarTab } from '../../../../../shared/ui-chrome/ui-chrome-types'

const TOP_ACTIVITY_BUTTON_WIDTH = 36
const TOP_ACTIVITY_MORE_BUTTON_WIDTH = 32

// Why: DSH header tabs are text pills with variable width, unlike the fixed
// 36px icon buttons, so overflow is estimated from title length instead.
const DSH_HEADER_TAB_BASE_WIDTH = 24
const DSH_HEADER_TAB_CHAR_WIDTH = 13
const DSH_HEADER_CLOSE_WIDTH = 36
const DSH_HEADER_MORE_BUTTON_WIDTH = 28

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

export function getDshHeaderTabLayout<T extends { id: ActiveRightSidebarTab; title: string }>(
  items: readonly T[],
  availableWidth: number | null,
  activeId: ActiveRightSidebarTab
): { visibleItems: T[]; overflowItems: T[] } {
  if (!availableWidth || !Number.isFinite(availableWidth)) {
    return { visibleItems: [...items], overflowItems: [] }
  }
  const widths = items.map(
    (item) => DSH_HEADER_TAB_BASE_WIDTH + [...item.title].length * DSH_HEADER_TAB_CHAR_WIDTH
  )
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (total <= availableWidth - DSH_HEADER_CLOSE_WIDTH) {
    return { visibleItems: [...items], overflowItems: [] }
  }
  const budget = availableWidth - DSH_HEADER_CLOSE_WIDTH - DSH_HEADER_MORE_BUTTON_WIDTH
  const visibleItems: T[] = []
  let used = 0
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0 && used + (widths[index] ?? 0) > budget) {
      break
    }
    used += widths[index] ?? 0
    const item = items[index]
    if (item) {
      visibleItems.push(item)
    }
  }
  if (visibleItems.length === 0 && items.length > 0 && items[0]) {
    visibleItems.push(items[0])
  }
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
