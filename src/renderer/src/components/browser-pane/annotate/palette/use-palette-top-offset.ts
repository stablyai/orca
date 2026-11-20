import { useLayoutEffect, useState, type RefObject } from 'react'

/** Marks the find-in-page bar so the palette can sit below it when they would overlap. */
export const BROWSER_FIND_BAR_ATTRIBUTE = 'data-browser-find-bar'
const PALETTE_TOP_PX = 8

/** 8px from the top, or 8px below the find bar while the two would overlap horizontally. */
export function usePaletteTopOffset(
  bounds: HTMLElement | null,
  paletteRef: RefObject<HTMLElement | null>,
  left: number | null
): number {
  const [top, setTop] = useState(PALETTE_TOP_PX)

  useLayoutEffect(() => {
    const palette = paletteRef.current
    if (!bounds || !palette) {
      return
    }
    const measure = (): void => {
      const findBar = bounds.querySelector<HTMLElement>(`[${BROWSER_FIND_BAR_ATTRIBUTE}]`)
      if (!findBar) {
        setTop(PALETTE_TOP_PX)
        return
      }
      const boundsRect = bounds.getBoundingClientRect()
      const findRect = findBar.getBoundingClientRect()
      const paletteLeft = boundsRect.left + (left ?? 0)
      const paletteRight = paletteLeft + palette.offsetWidth
      const overlaps = paletteLeft < findRect.right && paletteRight > findRect.left
      setTop(overlaps ? findRect.bottom - boundsRect.top + PALETTE_TOP_PX : PALETTE_TOP_PX)
    }
    const resize = new ResizeObserver(measure)
    resize.observe(bounds)
    resize.observe(palette)
    let observedFind: HTMLElement | null = null
    const refresh = (): void => {
      const find = bounds.querySelector<HTMLElement>(`[${BROWSER_FIND_BAR_ATTRIBUTE}]`)
      if (find !== observedFind) {
        if (observedFind) {
          resize.unobserve(observedFind)
        }
        observedFind = find
        if (find) {
          resize.observe(find)
        }
      }
      measure()
    }
    refresh()
    const observer = new MutationObserver(refresh)
    observer.observe(bounds, { childList: true })
    return () => {
      resize.disconnect()
      observer.disconnect()
    }
  }, [bounds, left, paletteRef])

  return top
}
