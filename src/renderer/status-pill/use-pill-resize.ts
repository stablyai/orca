import { useEffect, type RefObject } from 'react'
import type { StatusPillPreloadApi } from '../../shared/status-pill-preload-api'

// Why: mirror the main-side PILL_WINDOW_PADDING_* constants (createStatusPillWindow)
// so the renderer-side window-size sent via statusPill:resize accounts for the
// shadow halo. Duplicated (not imported) because the placement/window modules
// pull in Electron types the renderer sandbox cannot see.
const PILL_RENDERER_PADDING_X = 18
const PILL_RENDERER_PADDING_TOP = 6
const PILL_RENDERER_PADDING_BOTTOM = 34

// Why: delay the shrink so the panel's CSS collapse animation finishes before
// the window clips its bounds (avoids a one-frame flicker mid-animation).
const SHRINK_DEBOUNCE_MS = 260

/** Measure the live .pill-stack size and ask main to resize the BrowserWindow
 *  so the capsule + expanded panel always have room to render without clipping.
 *  Grows immediately, shrinks on a short delay so the collapse animation can
 *  finish first. */
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
      api.resize(width, height)
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) {
        return
      }
      // Why: content rect + the renderer-side padding so the shadow halo still
      // has room when the window grows to fit the expanded panel.
      const nextWidth = Math.ceil(entry.contentRect.width + PILL_RENDERER_PADDING_X * 2)
      const nextHeight = Math.ceil(
        entry.contentRect.height + PILL_RENDERER_PADDING_TOP + PILL_RENDERER_PADDING_BOTTOM
      )
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
