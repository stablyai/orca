import { measureElement, type Virtualizer } from '@tanstack/react-virtual'

/** False under a `display: none` ancestor, where every size reads as 0. */
export function hasLayoutBox(element: Element): boolean {
  return element.getClientRects().length > 0
}

/** Keep TanStack row measurements while any ancestor hides the scroller; caching ResizeObserver’s hidden 0px reports shifts visible content on re-show. DOM visibility needs no caller prop. */
export function measureVirtualRowRetainingHiddenSize<TScrollElement extends Element>(
  element: Element,
  entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<TScrollElement, Element>
): number {
  const scrollElement = instance.scrollElement
  if (scrollElement && !hasLayoutBox(scrollElement)) {
    const index = instance.indexFromElement(element)
    return (
      instance.itemSizeCache.get(instance.options.getItemKey(index)) ??
      instance.options.estimateSize(index)
    )
  }
  return measureElement(element, entry, instance)
}
