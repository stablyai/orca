import { useEffect, type RefObject } from 'react'
import type { StatusPillPreloadApi } from '../../shared/status-pill-preload-api'

/** Observe the live .pill-stack size/position and report its bounding rect
 *  (relative to the window) to the main process. Main offsets it by the live
 *  window origin and hit-tests the global cursor against it to drive the
 *  overlay's click-through (capture over the pill/panel, pass-through
 *  everywhere else). The window itself stays full-work-area-height so the
 *  panel never clips; the renderer never resizes it. */
export function usePillContentRect(
  api: StatusPillPreloadApi | undefined,
  stackRef: RefObject<HTMLDivElement | null>
): void {
  useEffect(() => {
    if (!api || !stackRef.current) {
      return
    }
    const element = stackRef.current
    const send = (): void => {
      const rect = element.getBoundingClientRect()
      api.setContentRect({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height
      })
    }
    send()
    const observer = new ResizeObserver(() => send())
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [api, stackRef])
}
