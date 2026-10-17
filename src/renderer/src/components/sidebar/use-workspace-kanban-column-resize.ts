import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import {
  WORKSPACE_BOARD_COLUMN_WIDTH_MAX,
  WORKSPACE_BOARD_COLUMN_WIDTH_MIN,
  WORKSPACE_BOARD_COLUMN_WIDTH_STEP,
  clampWorkspaceBoardColumnWidth
} from '../../../../shared/workspace-statuses'
import { useMeasuredWidth } from '../right-sidebar/right-sidebar-measured-width'

type WorkspaceKanbanColumnLayout = {
  expand: boolean
  open: boolean
  columnCount: number
  columnGap: number
}

type UseWorkspaceKanbanColumnResizeResult = {
  columnWidth: number
  columnWidthMax: number
  measureLaneScroller: (node: HTMLDivElement | null) => void
  isResizingColumn: boolean
  onColumnResizeStart: (event: React.PointerEvent<HTMLElement>) => void
  onColumnResizeKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void
}

export function useWorkspaceKanbanColumnResize(
  committedWidth: number,
  onCommitWidth: (width: number) => void,
  layout?: WorkspaceKanbanColumnLayout
): UseWorkspaceKanbanColumnResizeResult {
  const nextCommittedWidth = clampWorkspaceBoardColumnWidth(committedWidth)
  const [columnWidth, setColumnWidth] = useState(() =>
    clampWorkspaceBoardColumnWidth(committedWidth)
  )
  const [isResizingColumn, setIsResizingColumn] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [manuallyResized, setManuallyResized] = useState(false)
  const [previousOpen, setPreviousOpen] = useState(layout?.open)
  if (previousOpen !== layout?.open) {
    setPreviousOpen(layout?.open)
    setManuallyResized(false)
    setIsResizingColumn(false)
    setColumnWidth(nextCommittedWidth)
  }
  const measureLaneScroller = useMeasuredWidth(
    useCallback((width) => setViewportWidth(width ?? 0), [])
  )
  const fittedWidth =
    layout?.expand && layout.columnCount > 0
      ? (viewportWidth - (layout.columnCount - 1) * layout.columnGap) / layout.columnCount
      : 0
  const displayedWidth = layout?.expand
    ? manuallyResized
      ? columnWidth
      : Math.max(nextCommittedWidth, fittedWidth)
    : clampWorkspaceBoardColumnWidth(columnWidth)
  const columnWidthMax = Math.max(WORKSPACE_BOARD_COLUMN_WIDTH_MAX, fittedWidth, displayedWidth)
  const maxWidthRef = useRef(columnWidthMax)
  maxWidthRef.current = columnWidthMax
  const committedWidthRef = useRef(nextCommittedWidth)
  const commitWidthRef = useRef(onCommitWidth)
  const resizingRef = useRef(false)
  const resizeChangedRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(columnWidth)
  const startSizingRef = useRef({ columnWidth, manuallyResized })
  const draftWidthRef = useRef(columnWidth)
  const frameRef = useRef<number | null>(null)

  commitWidthRef.current = onCommitWidth
  if (committedWidthRef.current !== nextCommittedWidth) {
    committedWidthRef.current = nextCommittedWidth
    if (!resizingRef.current) {
      draftWidthRef.current = nextCommittedWidth
      if (columnWidth !== nextCommittedWidth) {
        // Why: external width changes should be reflected before children
        // render; during active drag the local draft remains authoritative.
        setColumnWidth(nextCommittedWidth)
      }
    }
  }

  const resetDocumentStyles = useCallback(() => {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const publishDraftWidth = useCallback((width: number) => {
    const nextWidth =
      resizingRef.current && width === startWidthRef.current
        ? width
        : Math.min(
            maxWidthRef.current,
            Math.max(WORKSPACE_BOARD_COLUMN_WIDTH_MIN, Math.round(width))
          )
    if (nextWidth === draftWidthRef.current) {
      return
    }
    draftWidthRef.current = nextWidth
    resizeChangedRef.current = true
    if (frameRef.current !== null) {
      return
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      setManuallyResized(true)
      setColumnWidth(draftWidthRef.current)
    })
  }, [])

  const commitDraftWidth = useCallback(() => {
    const nextWidth = clampWorkspaceBoardColumnWidth(draftWidthRef.current)
    // Auto-expanded widths stay local; persisted preferences retain their existing limits.
    setColumnWidth(draftWidthRef.current)
    setManuallyResized(true)
    if (nextWidth !== committedWidthRef.current) {
      committedWidthRef.current = nextWidth
      commitWidthRef.current(nextWidth)
    }
  }, [])

  const stopResize = useCallback(() => {
    if (!resizingRef.current) {
      return
    }
    resizingRef.current = false
    setIsResizingColumn(false)
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    resetDocumentStyles()
    if (draftWidthRef.current === startWidthRef.current) {
      setColumnWidth(startSizingRef.current.columnWidth)
      setManuallyResized(startSizingRef.current.manuallyResized)
    } else if (resizeChangedRef.current) {
      commitDraftWidth()
    }
  }, [commitDraftWidth, resetDocumentStyles])

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      if (
        !resizingRef.current ||
        (event.clientX === startXRef.current && !resizeChangedRef.current)
      ) {
        return
      }
      publishDraftWidth(startWidthRef.current + (event.clientX - startXRef.current))
    },
    [publishDraftWidth]
  )

  useEffect(() => {
    if (layout?.open === false) {
      return
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResize)
    window.addEventListener('pointercancel', stopResize)
    window.addEventListener('blur', stopResize)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResize)
      window.removeEventListener('pointercancel', stopResize)
      window.removeEventListener('blur', stopResize)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      resizingRef.current = false
      resetDocumentStyles()
    }
  }, [handlePointerMove, layout?.open, resetDocumentStyles, stopResize])

  const onColumnResizeStart = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      resizingRef.current = true
      resizeChangedRef.current = false
      setIsResizingColumn(true)
      startXRef.current = event.clientX
      startWidthRef.current = displayedWidth
      startSizingRef.current = { columnWidth, manuallyResized }
      draftWidthRef.current = displayedWidth
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [columnWidth, displayedWidth, manuallyResized]
  )

  const onColumnResizeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowRight' ? 1 : -1
      const step = WORKSPACE_BOARD_COLUMN_WIDTH_STEP * (event.shiftKey ? 2 : 1)
      resizeChangedRef.current = false
      draftWidthRef.current = displayedWidth
      publishDraftWidth(displayedWidth + direction * step)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      if (resizeChangedRef.current) {
        commitDraftWidth()
      }
    },
    [commitDraftWidth, displayedWidth, publishDraftWidth]
  )

  return {
    columnWidth: displayedWidth,
    columnWidthMax,
    measureLaneScroller,
    isResizingColumn,
    onColumnResizeStart,
    onColumnResizeKeyDown
  }
}
