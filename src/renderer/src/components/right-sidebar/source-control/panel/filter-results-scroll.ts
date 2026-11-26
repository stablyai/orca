import { useLayoutEffect, useRef, type RefObject } from 'react'

/** Scroll offset at which the sticky header just sticks, read from the first element after it. */
function headerStickTop(header: HTMLElement): number | null {
  const next = header.nextElementSibling
  return next instanceof HTMLElement ? next.offsetTop - header.offsetHeight : null
}

/**
 * Sizes the spacer so the scroll range ends exactly where the header sticks: a shrinking result
 * list cannot clamp scrollTop and move the header's input, and results cannot scroll away under it.
 */
function fitSpacer(header: HTMLElement, spacer: HTMLElement, scroller: HTMLElement): number | null {
  const stickTop = headerStickTop(header)
  if (stickTop === null) {
    return null
  }
  const contentHeight = scroller.scrollHeight - spacer.offsetHeight
  spacer.style.height = `${Math.max(0, stickTop + scroller.clientHeight - contentHeight)}px`
  return stickTop
}

/**
 * While a filter is open or active under the sticky file-list header, keeps the header (and its
 * input) still as results change, and starts new results right under it. Returns the spacer ref.
 */
export function useStickyFilterScroll(
  header: RefObject<HTMLElement | null>,
  scroller: HTMLElement | null,
  normalizedFilter: string,
  active: boolean
): RefObject<HTMLDivElement | null> {
  const spacer = useRef<HTMLDivElement>(null)
  const lastFilter = useRef(normalizedFilter)

  // No deps: results, feedback and collapsed sections all change the list height between renders.
  useLayoutEffect(() => {
    const filterChanged = lastFilter.current !== normalizedFilter
    lastFilter.current = normalizedFilter
    const headerNode = header.current
    const spacerNode = spacer.current
    if (!active || !headerNode || !spacerNode || !scroller) {
      return
    }
    const stickTop = fitSpacer(headerNode, spacerNode, scroller)
    if (filterChanged && stickTop !== null && scroller.scrollTop > stickTop) {
      scroller.scrollTo({ top: stickTop })
    }
  })

  useLayoutEffect(() => {
    if (!active || !scroller) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (header.current && spacer.current) {
        fitSpacer(header.current, spacer.current, scroller)
      }
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [header, scroller, active])

  return spacer
}
