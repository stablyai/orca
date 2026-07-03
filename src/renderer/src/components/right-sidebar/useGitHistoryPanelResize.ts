import React, { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_GIT_HISTORY_PANEL_HEIGHT = 256
export const MIN_GIT_HISTORY_PANEL_HEIGHT = 96
export const MAX_GIT_HISTORY_PANEL_HEIGHT = 520
const MAX_GIT_HISTORY_PANEL_VIEWPORT_HEIGHT = '33vh'

type GitHistoryResizeSession = {
  startY: number
  startHeight: number
  previousCursor: string
  previousUserSelect: string
}

function clampGitHistoryPanelHeight(height: number): number {
  return Math.min(MAX_GIT_HISTORY_PANEL_HEIGHT, Math.max(MIN_GIT_HISTORY_PANEL_HEIGHT, height))
}

export type GitHistoryPanelResize = {
  panelHeight: number
  startResize: (event: React.PointerEvent<HTMLDivElement>) => void
  handleResizeKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  expandedBodyStyle: { height: string }
}

// Drag/keyboard resize for the commit-history panel body. Extracted from
// GitHistoryPanel to keep that component under the max-lines limit.
export function useGitHistoryPanelResize(collapsed: boolean): GitHistoryPanelResize {
  const [panelHeight, setPanelHeight] = useState(DEFAULT_GIT_HISTORY_PANEL_HEIGHT)
  const resizeSessionRef = useRef<GitHistoryResizeSession | null>(null)

  const stopResize = useCallback((): void => {
    const session = resizeSessionRef.current
    if (!session) {
      return
    }
    resizeSessionRef.current = null
    document.body.style.cursor = session.previousCursor
    document.body.style.userSelect = session.previousUserSelect
  }, [])

  const handleResizePointerMove = useCallback((event: PointerEvent): void => {
    const session = resizeSessionRef.current
    if (!session) {
      return
    }
    setPanelHeight(clampGitHistoryPanelHeight(session.startHeight + session.startY - event.clientY))
  }, [])

  useEffect(() => {
    window.addEventListener('pointermove', handleResizePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('pointermove', handleResizePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
      stopResize()
    }
  }, [handleResizePointerMove, stopResize])

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (collapsed) {
        return
      }
      event.preventDefault()
      resizeSessionRef.current = {
        startY: event.clientY,
        startHeight: panelHeight,
        previousCursor: document.body.style.cursor,
        previousUserSelect: document.body.style.userSelect
      }
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
      event.currentTarget.setPointerCapture(event.pointerId)
    },
    [collapsed, panelHeight]
  )

  const handleResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 32 : 16
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setPanelHeight((height) => clampGitHistoryPanelHeight(height + step))
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setPanelHeight((height) => clampGitHistoryPanelHeight(height - step))
    } else if (event.key === 'Home') {
      event.preventDefault()
      setPanelHeight(MIN_GIT_HISTORY_PANEL_HEIGHT)
    } else if (event.key === 'End') {
      event.preventDefault()
      setPanelHeight(MAX_GIT_HISTORY_PANEL_HEIGHT)
    }
  }, [])

  return {
    panelHeight,
    startResize,
    handleResizeKeyDown,
    expandedBodyStyle: {
      height: `min(${panelHeight}px, ${MAX_GIT_HISTORY_PANEL_VIEWPORT_HEIGHT})`
    }
  }
}
