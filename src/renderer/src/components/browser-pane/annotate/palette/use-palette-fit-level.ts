import { useLayoutEffect, useState, type RefObject } from 'react'
import { PALETTE_EDGE_INSET_PX } from './use-palette-horizontal-drag'

const MAX_FIT_LEVEL = 2

/**
 * Steps the palette down one compaction level per layout pass until it fits its bounds.
 * Why measured: German and other long labels overflow at widths where English fits.
 */
export function usePaletteFitLevel(
  paletteRef: RefObject<HTMLElement | null>,
  bounds: HTMLElement | null,
  contentKey: string
): number {
  const [state, setState] = useState({ level: 0, boundsWidth: 0, contentKey })
  // New content may fit at a lower level, so start again from the full palette.
  const level = state.contentKey === contentKey ? state.level : 0

  useLayoutEffect(() => {
    const palette = paletteRef.current
    if (!palette || !bounds) {
      return
    }
    const overflows = (boundsWidth: number): boolean =>
      palette.scrollWidth > boundsWidth - PALETTE_EDGE_INSET_PX * 2 + 0.5
    let settleFrame = 0
    const step = (prev: typeof state, boundsWidth: number): typeof state => {
      const prevLevel = prev.contentKey === contentKey ? prev.level : 0
      // Wider bounds may fit a fuller palette again: start over and step down.
      if (boundsWidth > prev.boundsWidth && prevLevel > 0) {
        return { level: 0, boundsWidth, contentKey }
      }
      const nextLevel =
        overflows(boundsWidth) && prevLevel < MAX_FIT_LEVEL ? prevLevel + 1 : prevLevel
      if (
        nextLevel === prev.level &&
        boundsWidth === prev.boundsWidth &&
        contentKey === prev.contentKey
      ) {
        return prev
      }
      return { level: nextLevel, boundsWidth, contentKey }
    }
    const check = (): void => {
      const boundsWidth = bounds.clientWidth
      if (boundsWidth === 0) {
        return
      }
      // Why wait before the last step: a compact Draw row arrives a render later through its portal, and wrapping
      // on the interim width would stick even though the compact row fits.
      if (level === MAX_FIT_LEVEL - 1 && overflows(boundsWidth)) {
        cancelAnimationFrame(settleFrame)
        settleFrame = requestAnimationFrame(() => {
          settleFrame = requestAnimationFrame(() => setState((prev) => step(prev, boundsWidth)))
        })
        return
      }
      setState((prev) => step(prev, boundsWidth))
    }
    check()
    if (typeof ResizeObserver === 'undefined') {
      return () => cancelAnimationFrame(settleFrame)
    }
    const observer = new ResizeObserver(check)
    observer.observe(bounds)
    // Content that arrives later (Draw's tools render through a portal) changes the palette, not the bounds.
    observer.observe(palette)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(settleFrame)
    }
  }, [bounds, contentKey, level, paletteRef])

  return level
}
