import { widestPaletteWidth } from './palette-focus-and-fit'
import { useLayoutEffect, useState, type RefObject } from 'react'

export const BROWSER_FIND_BAR_ATTRIBUTE = 'data-browser-find-bar'
const PALETTE_TOP_PX = 8

function observePaletteFindGeometry(
  bounds: HTMLElement,
  palette: HTMLElement,
  labelProbe: HTMLElement,
  updateTop: (top: number) => void
): () => void {
  const measure = (): void => {
    const findBar = bounds.querySelector<HTMLElement>(`[${BROWSER_FIND_BAR_ATTRIBUTE}]`)
    if (!findBar) {
      updateTop(PALETTE_TOP_PX)
      return
    }
    const boundsRect = bounds.getBoundingClientRect()
    const findRect = findBar.getBoundingClientRect()
    const paletteRect = palette.getBoundingClientRect()
    const overlaps =
      paletteRect.left < findRect.right &&
      paletteRect.left + widestPaletteWidth(bounds, labelProbe) > findRect.left
    updateTop(overlaps ? findRect.bottom - boundsRect.top + PALETTE_TOP_PX : PALETTE_TOP_PX)
  }
  const resize = new ResizeObserver(measure)
  resize.observe(bounds)
  resize.observe(labelProbe)
  const styles = new MutationObserver(measure)
  let observedFind: HTMLElement | null | undefined
  const refresh = (): void => {
    const find = bounds.querySelector<HTMLElement>(`[${BROWSER_FIND_BAR_ATTRIBUTE}]`)
    if (find !== observedFind) {
      if (observedFind) {
        resize.unobserve(observedFind)
      }
      observedFind = find
      styles.disconnect()
      styles.observe(palette, { attributes: true, attributeFilter: ['style'] })
      if (find) {
        resize.observe(find)
        styles.observe(find, { attributes: true, attributeFilter: ['style', 'class'] })
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
    styles.disconnect()
  }
}

/** Keep the palette below an overlapping find bar as either surface moves or resizes. */
export function usePaletteTopOffset(
  bounds: HTMLElement | null,
  paletteRef: RefObject<HTMLElement | null>,
  labelProbeRef: RefObject<HTMLElement | null>,
  left: number | null
): number {
  const [top, setTop] = useState(PALETTE_TOP_PX)
  useLayoutEffect(() => {
    const palette = paletteRef.current
    const labelProbe = labelProbeRef.current
    if (!bounds || !palette || !labelProbe) {
      return
    }
    return observePaletteFindGeometry(bounds, palette, labelProbe, setTop)
  }, [bounds, left, paletteRef, labelProbeRef])
  return top
}
