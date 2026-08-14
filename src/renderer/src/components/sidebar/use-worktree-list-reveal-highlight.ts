import { useCallback, useRef, useState } from 'react'

type Result = {
  highlightedRevealRowKey: string | null
  flashRevealedRow: (rowKey: string) => void
  schedulePendingRevealFrame: (callback: FrameRequestCallback) => void
  cancelPendingRevealFrames: () => void
  clearRevealHighlight: () => void
}

export function useWorktreeListRevealHighlight(): Result {
  const [highlightedRevealRowKey, setHighlightedRevealRowKey] = useState<string | null>(null)
  const pendingRevealFrameIdsRef = useRef<Set<number>>(new Set())
  const revealHighlightFrameIdRef = useRef<number | null>(null)
  const revealHighlightTimeoutRef = useRef<number | null>(null)
  const cancelPendingRevealFrames = useCallback(() => {
    for (const frameId of pendingRevealFrameIdsRef.current) {
      window.cancelAnimationFrame(frameId)
    }
    pendingRevealFrameIdsRef.current.clear()
  }, [])
  const schedulePendingRevealFrame = useCallback((callback: FrameRequestCallback) => {
    const frameId = window.requestAnimationFrame((time) => {
      pendingRevealFrameIdsRef.current.delete(frameId)
      callback(time)
    })
    pendingRevealFrameIdsRef.current.add(frameId)
  }, [])
  const clearRevealHighlightFrame = useCallback(() => {
    if (revealHighlightFrameIdRef.current !== null) {
      window.cancelAnimationFrame(revealHighlightFrameIdRef.current)
      revealHighlightFrameIdRef.current = null
    }
  }, [])
  const clearRevealHighlightTimeout = useCallback(() => {
    if (revealHighlightTimeoutRef.current !== null) {
      window.clearTimeout(revealHighlightTimeoutRef.current)
      revealHighlightTimeoutRef.current = null
    }
  }, [])
  const flashRevealedRow = useCallback(
    (rowKey: string) => {
      clearRevealHighlightTimeout()
      clearRevealHighlightFrame()
      // Why: clear before set restarts the CSS glow when revealing the same row repeatedly.
      setHighlightedRevealRowKey(null)
      revealHighlightFrameIdRef.current = window.requestAnimationFrame(() => {
        revealHighlightFrameIdRef.current = null
        setHighlightedRevealRowKey(rowKey)
        revealHighlightTimeoutRef.current = window.setTimeout(() => {
          revealHighlightTimeoutRef.current = null
          setHighlightedRevealRowKey(null)
        }, 1500)
      })
    },
    [clearRevealHighlightFrame, clearRevealHighlightTimeout]
  )
  const clearRevealHighlight = useCallback(() => {
    clearRevealHighlightFrame()
    clearRevealHighlightTimeout()
  }, [clearRevealHighlightFrame, clearRevealHighlightTimeout])
  return {
    highlightedRevealRowKey,
    flashRevealedRow,
    schedulePendingRevealFrame,
    cancelPendingRevealFrames,
    clearRevealHighlight
  }
}
