import { useEffect, useState } from 'react'

// Two stable frames straddle the gap between saved-bounds restore and maximization; one may land inside it.
const REQUIRED_STABLE_FRAMES = 2
// Bound settling so continuous resize cannot prevent terminals from ever mounting.
const MAX_SETTLE_MS = 300

function readViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

/** Latch after initial viewport settling to avoid a second fit corrupting live TUIs; ordinary resizes use the normal fit path. */
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
