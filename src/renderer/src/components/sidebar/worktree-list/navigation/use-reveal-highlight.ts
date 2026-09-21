import { useCallback, useRef, useState } from 'react'

export type SidebarRevealHighlight = ReturnType<typeof useSidebarRevealHighlight>

// Owns the frames a reveal schedules and the short glow it leaves on the revealed row.
export function useSidebarRevealHighlight() {
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

  return {
    highlightedRevealRowKey,
    cancelPendingRevealFrames,
    schedulePendingRevealFrame,
    clearRevealHighlightFrame,
    clearRevealHighlightTimeout,
    flashRevealedRow
  }
}
