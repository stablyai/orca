import { useEffect, type RefObject } from 'react'
import type { StatusPillPreloadApi } from '../../shared/status-pill-preload-api'

// Why: the pill window is content-sized (NOT a tall click-through overlay), so
// it receives clicks like any normal window. To keep the expanded panel from
// clipping, the renderer measures the live island size and asks main to resize
// the BrowserWindow. Grow immediately; shrink on a short delay so the collapse
// animation finishes before the window clips it (anti-flicker).
const SHRINK_DEBOUNCE_MS = 260

export function usePillResize(
  api: StatusPillPreloadApi | undefined,
  stackRef: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    if (!api || !stackRef.current) {
      return
    }
    const element = stackRef.current
    let lastWidth = 0
    let lastHeight = 0
    let shrinkTimer: ReturnType<typeof setTimeout> | null = null
    const flush = (width: number, height: number): void => {
      if (width === lastWidth && height === lastHeight) {
        return
      }
      lastWidth = width
      lastHeight = height
      api.resize({ width, height })
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }
      const rect = entry.contentRect
      const nextWidth = Math.ceil(rect.width)
      const nextHeight = Math.ceil(rect.height)
      const growing = nextWidth > lastWidth || nextHeight > lastHeight
      if (shrinkTimer !== null) {
        clearTimeout(shrinkTimer)
        shrinkTimer = null
      }
      if (growing) {
        flush(nextWidth, nextHeight)
      } else {
        shrinkTimer = setTimeout(() => {
          shrinkTimer = null
          flush(nextWidth, nextHeight)
        }, SHRINK_DEBOUNCE_MS)
      }
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (shrinkTimer !== null) {
        clearTimeout(shrinkTimer)
        shrinkTimer = null
      }
    }
  }, [api, stackRef])
}
