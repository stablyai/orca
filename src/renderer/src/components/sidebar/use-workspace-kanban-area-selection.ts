import React, { useCallback, useEffect, useRef } from 'react'
import {
  clearPreviewSelection,
  getAreaSelectionCardIds,
  getAreaSelectionCardRects,
  getAreaSelectionRect,
  isScrollbarPointerDown,
  setOverlayRect,
  shouldIgnoreAreaSelectionStart,
  updatePreviewSelection,
  type AreaSelectionCardRect
} from './workspace-kanban-area-selection-dom'

type AreaSelectionDragState = {
  startX: number
  startY: number
  currentX: number
  currentY: number
  additive: boolean
  baseSelectedIds: Set<string>
  baseAnchorId: string | null
  boardRect: DOMRect
  cardRects: readonly AreaSelectionCardRect[]
  previewIds: Set<string>
  finalAreaIds: string[]
  started: boolean
  frameId: number | null
}

type UpdateSelectionForArea = (
  areaIds: readonly string[],
  additive: boolean,
  baseSelectedIds?: ReadonlySet<string>,
  baseAnchorId?: string | null
) => void

type UseWorkspaceKanbanAreaSelectionParams = {
  open: boolean
  boardRef: React.RefObject<HTMLDivElement | null>
  overlayRef: React.RefObject<HTMLDivElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectionAnchorId: string | null
  updateSelectionForArea: UpdateSelectionForArea
}

const AREA_SELECTION_DRAG_THRESHOLD = 4

export function useWorkspaceKanbanAreaSelection({
  open,
  boardRef,
  overlayRef,
  selectedWorktreeIds,
  selectionAnchorId,
  updateSelectionForArea
}: UseWorkspaceKanbanAreaSelectionParams): {
  handleAreaSelectionPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
} {
  const dragRef = useRef<AreaSelectionDragState | null>(null)
  const updateSelectionForAreaRef = useRef(updateSelectionForArea)

  useEffect(() => {
    updateSelectionForAreaRef.current = updateSelectionForArea
  }, [updateSelectionForArea])

  const cancelAreaSelectionDrag = useCallback(() => {
    const state = dragRef.current
    if (state?.frameId !== null && state?.frameId !== undefined) {
      window.cancelAnimationFrame(state.frameId)
    }
    if (state) {
      clearPreviewSelection(state.cardRects, state.previewIds)
    }
    dragRef.current = null
    setOverlayRect(overlayRef.current, null)
  }, [overlayRef])

  const flushAreaSelectionDrag = useCallback(() => {
    const state = dragRef.current
    if (!state) {
      return
    }

    state.frameId = null
    const deltaX = state.currentX - state.startX
    const deltaY = state.currentY - state.startY
    if (!state.started && Math.hypot(deltaX, deltaY) < AREA_SELECTION_DRAG_THRESHOLD) {
      return
    }

    state.started = true

    const viewportRect = getAreaSelectionRect(
      state.startX,
      state.startY,
      state.currentX,
      state.currentY
    )
    const clippedLeft = Math.max(viewportRect.left, state.boardRect.left)
    const clippedTop = Math.max(viewportRect.top, state.boardRect.top)
    const clippedRight = Math.min(viewportRect.left + viewportRect.width, state.boardRect.right)
    const clippedBottom = Math.min(viewportRect.top + viewportRect.height, state.boardRect.bottom)

    if (clippedRight <= clippedLeft || clippedBottom <= clippedTop) {
      state.finalAreaIds = []
      setOverlayRect(overlayRef.current, null)
      updatePreviewSelection(
        state.cardRects,
        state.previewIds,
        state.baseSelectedIds,
        state.additive,
        []
      )
      return
    }

    setOverlayRect(overlayRef.current, {
      left: clippedLeft - state.boardRect.left,
      top: clippedTop - state.boardRect.top,
      width: clippedRight - clippedLeft,
      height: clippedBottom - clippedTop
    })

    const areaIds = getAreaSelectionCardIds(state.cardRects, viewportRect)
    state.finalAreaIds = areaIds
    updatePreviewSelection(
      state.cardRects,
      state.previewIds,
      state.baseSelectedIds,
      state.additive,
      areaIds
    )
  }, [overlayRef])

  const scheduleAreaSelectionDragFlush = useCallback(() => {
    const state = dragRef.current
    if (!state || state.frameId !== null) {
      return
    }
    // Why: the hot path stays imperative and frame-throttled so a Notion-like
    // marquee drag does not re-render every workspace card on pointermove.
    state.frameId = window.requestAnimationFrame(flushAreaSelectionDrag)
  }, [flushAreaSelectionDrag])

  const finishAreaSelectionDrag = useCallback(
    (event: PointerEvent) => {
      const state = dragRef.current
      if (!state) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      if (state.frameId !== null) {
        window.cancelAnimationFrame(state.frameId)
        state.frameId = null
      }
      flushAreaSelectionDrag()
      if (state.started) {
        updateSelectionForAreaRef.current(
          state.finalAreaIds,
          state.additive,
          state.baseSelectedIds,
          state.baseAnchorId
        )
      }
      clearPreviewSelection(state.cardRects, state.previewIds)
      dragRef.current = null
      setOverlayRect(overlayRef.current, null)
    },
    [flushAreaSelectionDrag, overlayRef]
  )

  const handleAreaSelectionPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (
        event.button !== 0 ||
        event.pointerType === 'touch' ||
        isScrollbarPointerDown(event.nativeEvent) ||
        shouldIgnoreAreaSelectionStart(event.target)
      ) {
        return
      }

      const board = boardRef.current
      if (!board) {
        return
      }
      cancelAreaSelectionDrag()
      const isMac = navigator.userAgent.includes('Mac')
      const additive =
        event.shiftKey ||
        (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        additive,
        baseSelectedIds: new Set(selectedWorktreeIds),
        baseAnchorId: selectionAnchorId,
        boardRect: board.getBoundingClientRect(),
        cardRects: getAreaSelectionCardRects(board),
        previewIds: new Set(),
        finalAreaIds: [],
        started: false,
        frameId: null
      }
      event.preventDefault()
    },
    [boardRef, cancelAreaSelectionDrag, selectedWorktreeIds, selectionAnchorId]
  )

  useEffect(() => {
    if (!open) {
      cancelAreaSelectionDrag()
      return
    }

    const handlePointerMove = (event: PointerEvent): void => {
      const state = dragRef.current
      if (!state) {
        return
      }
      state.currentX = event.clientX
      state.currentY = event.clientY
      event.preventDefault()
      scheduleAreaSelectionDragFlush()
    }

    const handlePointerUp = (event: PointerEvent): void => {
      if (!dragRef.current) {
        return
      }
      event.preventDefault()
      finishAreaSelectionDrag(event)
    }

    document.addEventListener('pointermove', handlePointerMove, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerUp, true)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerUp, true)
      cancelAreaSelectionDrag()
    }
  }, [cancelAreaSelectionDrag, finishAreaSelectionDrag, open, scheduleAreaSelectionDragFlush])

  return { handleAreaSelectionPointerDown }
}
