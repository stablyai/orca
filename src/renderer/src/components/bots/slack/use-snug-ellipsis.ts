// A truncated name leaves the clipped part of its box empty after the ellipsis; this closes that gap.
import { useLayoutEffect, type RefObject } from 'react'

/**
 * Narrows the row's one `data-snug-ellipsis` name to the text it shows plus its ellipsis, so the words after it sit right
 * against the ellipsis ("m4-air-build-ser…’s"). Re-fits when the row's width or `text` changes.
 */
export function useSnugEllipsis(rowRef: RefObject<HTMLElement | null>, text: string | null): void {
  useLayoutEffect(() => {
    const row = rowRef.current
    const name = row?.querySelector<HTMLElement>('[data-snug-ellipsis]')
    if (!row || !name || text === null) {
      return
    }
    let disposed = false
    const fit = (): void => {
      if (disposed) {
        return
      }
      // Measure at the width the row would give it, then narrow.
      name.style.maxWidth = ''
      const width = snugWidth(name)
      if (width !== null) {
        name.style.maxWidth = `${width}px`
      }
    }
    fit()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit)
    observer?.observe(row)
    // Widths change once the UI font finishes loading.
    void document.fonts?.ready.then(fit)
    return () => {
      disposed = true
      observer?.disconnect()
      name.style.maxWidth = ''
    }
  }, [rowRef, text])
}

/** The width of the characters that fit plus the ellipsis, or null when the whole name fits. */
function snugWidth(name: HTMLElement): number | null {
  const node = name.firstChild
  if (!(node instanceof Text) || name.scrollWidth <= name.clientWidth) {
    return null
  }
  const left = name.getBoundingClientRect().left
  const available = name.clientWidth
  const ellipsis = ellipsisWidth(name)
  const range = document.createRange()
  const end = (count: number): number => {
    range.setStart(node, 0)
    range.setEnd(node, count)
    return range.getBoundingClientRect().right - left
  }
  // The most characters that fit beside the ellipsis, as the browser picks them.
  let low = 0
  let high = node.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (end(mid) + ellipsis <= available) {
      low = mid
    } else {
      high = mid - 1
    }
  }
  // A little slack so rounding never drops one more character than the browser would.
  return Math.min(available, (low === 0 ? 0 : end(low)) + ellipsis + 0.5)
}

let measureContext: CanvasRenderingContext2D | null | undefined

function ellipsisWidth(name: HTMLElement): number {
  measureContext ??= document.createElement('canvas').getContext('2d')
  if (!measureContext) {
    return 0
  }
  measureContext.font = getComputedStyle(name).font
  return measureContext.measureText('…').width
}
