import type { VirtualizedScrollAnchor } from './useVirtualizedScrollAnchor'

type VirtualScrollItem = {
  end: number
  index: number
  start: number
}

export function findVirtualizedDomScrollAnchor<TItemElement extends Element>({
  getItemElementKey,
  itemElementSelector,
  rowIndexByKey,
  scrollElement
}: {
  getItemElementKey: (element: TItemElement) => string | null
  itemElementSelector: string
  rowIndexByKey: ReadonlyMap<string, number>
  scrollElement: Element
}): NonNullable<VirtualizedScrollAnchor> | null {
  const scrollRect = scrollElement.getBoundingClientRect()
  type DomAnchorItem = { key: string; rect: DOMRect }
  const visibleItems = Array.from(scrollElement.querySelectorAll<TItemElement>(itemElementSelector))
    .map((element) => {
      const key = getItemElementKey(element)
      if (!key || !rowIndexByKey.has(key) || !element.isConnected) {
        return null
      }
      const rect = element.getBoundingClientRect()
      if (rect.height <= 0 || rect.bottom <= scrollRect.top || rect.top >= scrollRect.bottom) {
        return null
      }
      return { key, rect }
    })
    .filter((item): item is DomAnchorItem => item != null)
    .sort((a, b) => a.rect.top - b.rect.top)

  const [firstVisible] = visibleItems
  if (!firstVisible) {
    return null
  }

  return {
    fallbackKeys: visibleItems.slice(1).map((item) => item.key),
    key: firstVisible.key,
    offset: Math.min(firstVisible.rect.height, Math.max(0, scrollRect.top - firstVisible.rect.top)),
    scrollTop: scrollElement.scrollTop
  }
}

export function getVirtualizedScrollAnchorForOffset<TRow>({
  getRowKey,
  rows,
  scrollTop,
  virtualItems
}: {
  getRowKey: (row: TRow) => string
  rows: readonly TRow[]
  scrollTop: number
  virtualItems: readonly VirtualScrollItem[]
}): VirtualizedScrollAnchor {
  const firstVisible = virtualItems.find((item) => item.end > scrollTop)
  const row = firstVisible ? rows[firstVisible.index] : undefined
  if (!firstVisible || !row) {
    return null
  }

  return {
    fallbackKeys: virtualItems
      .slice(virtualItems.indexOf(firstVisible) + 1)
      .map((item) => rows[item.index])
      .filter((row): row is TRow => row != null)
      .map(getRowKey),
    key: getRowKey(row),
    offset: Math.max(0, scrollTop - firstVisible.start),
    scrollTop
  }
}
