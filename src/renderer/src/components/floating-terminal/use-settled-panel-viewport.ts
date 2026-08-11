import { useEffect, useState } from 'react'

// Why two frames: the main window restores its saved bounds and only then maximizes, so
// the renderer's first layout can be a size the window is about to leave. One unchanged
// frame can land inside that gap; two straddle it.
const REQUIRED_STABLE_FRAMES = 2
// Why a cap: a window that never stops resizing (a drag, a display change) must not hold
// the panel's terminals forever. Mounting at a stale size is recoverable; never mounting is not.
const MAX_SETTLE_MS = 300

function readViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/**
 * Reports true once the viewport has held one size across consecutive frames.
 *
 * Why the floating panel waits for this: its maximized rect is derived from the live
 * viewport, so mounting terminals against a pre-maximize viewport fits them to a grid the
 * window is about to leave. The correcting fit then reflows the xterm buffer under a live
 * TUI, which is the damage this whole path exists to avoid. Latching true is deliberate —
 * later resizes are ordinary user resizes and the normal fit path owns them.
 */
export function useSettledPanelViewport(): boolean {
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    if (settled || typeof window === 'undefined') {
      return
    }
    if (typeof requestAnimationFrame !== 'function') {
      setSettled(true)
      return
    }
    let frameId: number | null = null
    let previous = readViewport()
    let stableFrames = 0
    const settle = (): void => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
        frameId = null
      }
      setSettled(true)
    }
    const capId = setTimeout(settle, MAX_SETTLE_MS)
    const step = (): void => {
      const current = readViewport()
      stableFrames =
        current.width === previous.width && current.height === previous.height
          ? stableFrames + 1
          : 0
      previous = current
      if (stableFrames >= REQUIRED_STABLE_FRAMES) {
        settle()
        return
      }
      frameId = requestAnimationFrame(step)
    }
    frameId = requestAnimationFrame(step)
    return () => {
      clearTimeout(capId)
      if (frameId !== null) {
        cancelAnimationFrame(frameId)
      }
    }
  }, [settled])

  return settled
}
