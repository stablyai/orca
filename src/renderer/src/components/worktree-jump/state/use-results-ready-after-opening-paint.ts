import { startTransition, useCallback, useEffect, useState } from 'react'
import { flushSync } from 'react-dom'

// Hidden windows may never run animation frames; results must still arrive there.
const HIDDEN_WINDOW_FALLBACK_MS = 100

/**
 * False on the render that opens the palette, then true once that frame has painted, so
 * the input shows within a frame and the result index builds right after.
 */
export function useResultsReadyAfterOpeningPaint(visible: boolean): {
  resultsReady: boolean
  revealResultsNow: () => void
} {
  const [ready, setReady] = useState(false)
  const [wasVisible, setWasVisible] = useState(visible)
  // A reopen during the close linger opens like a fresh mount; closing keeps results for the exit animation.
  if (visible !== wasVisible) {
    setWasVisible(visible)
    if (visible) {
      setReady(false)
    }
  }
  useEffect(() => {
    if (!visible || ready) {
      return
    }
    let paintTimer = 0
    const markReady = (): void => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(paintTimer)
      window.clearTimeout(fallbackTimer)
      startTransition(() => setReady(true))
    }
    // A timeout queued from an animation frame runs after that frame's paint.
    const frame = window.requestAnimationFrame(() => {
      paintTimer = window.setTimeout(markReady, 0)
    })
    const fallbackTimer = window.setTimeout(markReady, HIDDEN_WINDOW_FALLBACK_MS)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(paintTimer)
      window.clearTimeout(fallbackTimer)
    }
  }, [visible, ready])
  // An Enter or arrow key before the results land must act on them, as it did when opening blocked.
  const revealResultsNow = useCallback(() => {
    flushSync(() => setReady(true))
  }, [])
  return { resultsReady: ready, revealResultsNow }
}
