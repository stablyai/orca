import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from 'react'

const DEFAULT_GIT_HISTORY_PANEL_HEIGHT = 256
export const MIN_GIT_HISTORY_PANEL_HEIGHT = 96
export const MAX_GIT_HISTORY_PANEL_HEIGHT = 520

type GitHistoryResizeSession = {
  pointerId: number
  startY: number
  startHeight: number
  previousCursor: string
  previousUserSelect: string
}

export type GitHistoryPanelResize = {
  panelHeight: number
  onResizePointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onResizeKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

function clampGitHistoryPanelHeight(height: number): number {
  return Math.min(MAX_GIT_HISTORY_PANEL_HEIGHT, Math.max(MIN_GIT_HISTORY_PANEL_HEIGHT, height))
}

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

  const handleResizePointerMove = useCallback((event: globalThis.PointerEvent): void => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) {
      return
    }
    setPanelHeight(clampGitHistoryPanelHeight(session.startHeight + session.startY - event.clientY))
  }, [])

  const stopResizeForPointer = useCallback(
    (event: globalThis.PointerEvent): void => {
      if (resizeSessionRef.current?.pointerId !== event.pointerId) {
        return
      }
      stopResize()
    },
    [stopResize]
  )

  useEffect(() => {
    window.addEventListener('pointermove', handleResizePointerMove)
    window.addEventListener('pointerup', stopResizeForPointer)
    window.addEventListener('pointercancel', stopResizeForPointer)
    window.addEventListener('blur', stopResize)
    return () => {
      window.removeEventListener('pointermove', handleResizePointerMove)
      window.removeEventListener('pointerup', stopResizeForPointer)
      window.removeEventListener('pointercancel', stopResizeForPointer)
      window.removeEventListener('blur', stopResize)
      stopResize()
    }
  }, [handleResizePointerMove, stopResize, stopResizeForPointer])

  const onResizePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      // Why: a second touch must not hijack the pointer that owns the global drag session.
      if (collapsed || resizeSessionRef.current) {
        return
      }
      event.preventDefault()
      resizeSessionRef.current = {
        pointerId: event.pointerId,
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

  const onResizeKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
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

  return { panelHeight, onResizePointerDown, onResizeKeyDown }
}
