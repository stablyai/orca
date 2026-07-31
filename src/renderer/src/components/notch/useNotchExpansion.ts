import { useCallback, useEffect, useRef } from 'react'

/** Hover must dwell before opening, so crossing the bar on the way elsewhere doesn't. */
const HOVER_OPEN_DELAY_MS = 150
/** Leaving is forgiving — the pointer often clips the edge on its way to a row. */
const CLOSE_DELAY_MS = 500
/** Below this the pointer counts as resting, not travelling. */
const MOVEMENT_GATE_PX = 6

export type NotchExpansionHandlers = {
  onPointerEnter: (event: { clientX: number; clientY: number }) => void
  onPointerMove: (event: { clientX: number; clientY: number }) => void
  onPointerLeave: () => void
  /** Click opens immediately — an explicit gesture shouldn't wait on a dwell timer. */
  onClick: () => void
  cancelClose: () => void
}

/**
 * Drives expansion requests. Main owns the actual state (it must resize the window first), so
 * this only ever asks — `expanded` comes back through the snapshot.
 */
export function useNotchExpansion(
  expanded: boolean,
  setExpanded: (next: boolean) => void
): NotchExpansionHandlers {
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchor = useRef<{ x: number; y: number } | null>(null)

  const clearOpen = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current)
      openTimer.current = null
    }
  }, [])

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])

  useEffect(() => {
    return () => {
      clearOpen()
      cancelClose()
    }
  }, [clearOpen, cancelClose])

  const onPointerEnter = useCallback(
    (event: { clientX: number; clientY: number }) => {
      cancelClose()
      if (expanded || openTimer.current) {
        return
      }
      anchor.current = { x: event.clientX, y: event.clientY }
      openTimer.current = setTimeout(() => {
        openTimer.current = null
        setExpanded(true)
      }, HOVER_OPEN_DELAY_MS)
    },
    [expanded, setExpanded, cancelClose]
  )

  const onPointerMove = useCallback(
    (event: { clientX: number; clientY: number }) => {
      if (!openTimer.current || !anchor.current) {
        return
      }
      const dx = event.clientX - anchor.current.x
      const dy = event.clientY - anchor.current.y
      // Why: restart the dwell while the pointer is still travelling, so a fast pass across
      // the bar never opens the panel behind the cursor.
      if (Math.hypot(dx, dy) > MOVEMENT_GATE_PX) {
        anchor.current = { x: event.clientX, y: event.clientY }
        clearOpen()
        openTimer.current = setTimeout(() => {
          openTimer.current = null
          setExpanded(true)
        }, HOVER_OPEN_DELAY_MS)
      }
    },
    [setExpanded, clearOpen]
  )

  const onPointerLeave = useCallback(() => {
    clearOpen()
    anchor.current = null
    cancelClose()
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setExpanded(false)
    }, CLOSE_DELAY_MS)
  }, [setExpanded, clearOpen, cancelClose])

  const onClick = useCallback(() => {
    clearOpen()
    cancelClose()
    setExpanded(!expanded)
  }, [expanded, setExpanded, clearOpen, cancelClose])

  return { onPointerEnter, onPointerMove, onPointerLeave, onClick, cancelClose }
}
