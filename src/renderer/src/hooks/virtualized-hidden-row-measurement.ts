import { measureElement, type Virtualizer } from '@tanstack/react-virtual'

/** False under a `display: none` ancestor, where every size reads as 0. */
export function hasLayoutBox(element: Element): boolean {
  return element.getClientRects().length > 0
}

/**
 * TanStack `measureElement` that keeps each row's last size while the scroll
 * element has no layout box (a `display: none` ancestor, e.g. a hidden worktree).
 *
 * Hidden rows report 0px through ResizeObserver. Caching that collapses rows
 * above the viewport, so the unchanged scrollTop shows later content on re-show.
 * Unlike `useCachedMeasurements`, this reads the DOM, so it needs no visibility
 * prop and covers every hiding ancestor.
 */
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
