import { useCallback, useLayoutEffect, useSyncExternalStore, type RefObject } from 'react'

/**
 * When the filter query changes while the list is scrolled past the sticky file-list header,
 * start the results right under it. The stuck header (and its input) stays where it was.
 */
export function useFilterResultsStartUnderStickyHeader(
  header: RefObject<HTMLElement | null>,
  scroller: HTMLElement | null,
  normalizedFilter: string,
  enabled: boolean
): void {
  useLayoutEffect(() => {
    const node = header.current
    const next = node?.nextElementSibling
    if (!enabled || !node || !scroller || !(next instanceof HTMLElement)) {
      return
    }
    // The header is sticky, so read its unstuck top from the first element after it.
    const resultsTop = next.offsetTop - node.offsetHeight
    if (scroller.scrollTop > resultsTop) {
      scroller.scrollTop = resultsTop
    }
  }, [header, scroller, normalizedFilter, enabled])
}

/**
 * Height for the spacer after the list while a filter is open or active: one viewport minus the
 * sticky header, so a shrinking result list cannot clamp scrollTop and move the header's input.
 * (A percentage height does not resolve inside the scroller, so it is measured.)
 */
export function useStickyFilterSpacerHeight(
  scroller: HTMLElement | null,
  header: RefObject<HTMLElement | null>,
  active: boolean
): number {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!active || !scroller) {
        return () => {}
      }
      const observer = new ResizeObserver(onChange)
      observer.observe(scroller)
      return () => observer.disconnect()
    },
    [scroller, active]
  )
  // Reads layout only while a filter is open or active.
  const getSnapshot = (): number =>
    active && scroller
      ? Math.max(0, scroller.clientHeight - (header.current?.offsetHeight ?? 0))
      : 0
  return useSyncExternalStore(subscribe, getSnapshot, () => 0)
}
