import React, { useCallback, useEffect, useRef } from 'react'
import { getAreaSelectionCardRects } from './workspace-kanban-area-selection-card-rects'
import {
  clearPreviewSelection,
  getAreaSelectionAutoScrollDelta,
  getAreaSelectionCardIds,
  getAreaSelectionRect,
  getAreaSelectionScrollContainer,
  getAreaSelectionScrollStartContentYByElement,
  isScrollbarPointerDown,
  setOverlayRect,
  shouldIgnoreAreaSelectionStart,
  updatePreviewSelection
} from './workspace-kanban-area-selection-dom'
import {
  AREA_SELECTION_DRAG_THRESHOLD,
  shouldCommitWorkspaceKanbanAreaSelection,
  type AreaSelectionDragState,
  type UseWorkspaceKanbanAreaSelectionParams
} from './workspace-kanban-area-selection-state'

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

  // Why: pointer handlers are stable while selection commits must call the
  // latest board-selection updater before the next event can fire.
  updateSelectionForAreaRef.current = updateSelectionForArea

  const cancelAreaSelectionDrag = useCallback(() => {
    const state = dragRef.current
    if (state?.frameId !== null && state?.frameId !== undefined) {
      window.cancelAnimationFrame(state.frameId)
    }
    if (state?.scrollFrameId !== null && state?.scrollFrameId !== undefined) {
      window.cancelAnimationFrame(state.scrollFrameId)
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

    // Why: deferred card mount can start a marquee against empty rects; pick up
    // virtual layout once lanes register without waiting for a scroll event.
    if (state.cardRects.length === 0) {
      const board = boardRef.current
      if (board) {
        state.boardRect = board.getBoundingClientRect()
        state.cardRects = getAreaSelectionCardRects(board)
        state.scrollStartContentYByElement = getAreaSelectionScrollStartContentYByElement(
          board,
          state.startY
        )
      }
    }

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

    const areaIds = getAreaSelectionCardIds(state.cardRects, viewportRect, {
      scrollStartContentYByElement: state.scrollStartContentYByElement,
      currentY: state.currentY
    })
    state.finalAreaIds = areaIds
    updatePreviewSelection(
      state.cardRects,
      state.previewIds,
      state.baseSelectedIds,
      state.additive,
      areaIds
    )
  }, [boardRef, overlayRef])

  const refreshAreaSelectionMeasurements = useCallback(() => {
    const state = dragRef.current
    const board = boardRef.current
    if (!state || !board) {
      return
    }

    clearPreviewSelection(state.cardRects, state.previewIds)
    state.boardRect = board.getBoundingClientRect()
    state.cardRects = getAreaSelectionCardRects(board)
  }, [boardRef])

  const scheduleAreaSelectionDragFlush = useCallback(() => {
    const state = dragRef.current
    if (!state || state.frameId !== null) {
      return
    }
    // Why: the hot path stays imperative and frame-throttled so a Notion-like
    // marquee drag does not re-render every workspace card on pointermove.
    state.frameId = window.requestAnimationFrame(flushAreaSelectionDrag)
  }, [flushAreaSelectionDrag])

  const runAreaSelectionAutoScroll = useCallback(() => {
    const state = dragRef.current
    const board = boardRef.current
    if (!state || !board) {
      return
    }

    state.scrollFrameId = null
    const scrollContainer = getAreaSelectionScrollContainer(board, state.currentX, state.currentY)
    if (!scrollContainer) {
      return
    }

    const rect = scrollContainer.getBoundingClientRect()
    const scrollDelta = getAreaSelectionAutoScrollDelta({
      pointerY: state.currentY,
      containerTop: rect.top,
      containerBottom: rect.bottom,
      scrollTop: scrollContainer.scrollTop,
      scrollHeight: scrollContainer.scrollHeight,
      clientHeight: scrollContainer.clientHeight
    })
    if (scrollDelta === 0) {
      return
    }

    scrollContainer.scrollTop += scrollDelta
    refreshAreaSelectionMeasurements()
    scheduleAreaSelectionDragFlush()
    state.scrollFrameId = window.requestAnimationFrame(runAreaSelectionAutoScroll)
  }, [boardRef, refreshAreaSelectionMeasurements, scheduleAreaSelectionDragFlush])

  const scheduleAreaSelectionAutoScroll = useCallback(() => {
    const state = dragRef.current
    if (!state || state.scrollFrameId !== null) {
      return
    }
    state.scrollFrameId = window.requestAnimationFrame(runAreaSelectionAutoScroll)
  }, [runAreaSelectionAutoScroll])

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
      if (state.scrollFrameId !== null) {
        window.cancelAnimationFrame(state.scrollFrameId)
        state.scrollFrameId = null
      }
      refreshAreaSelectionMeasurements()
      flushAreaSelectionDrag()
      if (shouldCommitWorkspaceKanbanAreaSelection(state)) {
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
    [flushAreaSelectionDrag, overlayRef, refreshAreaSelectionMeasurements]
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
        scrollStartContentYByElement: getAreaSelectionScrollStartContentYByElement(
          board,
          event.clientY
        ),
        previewIds: new Set(),
        finalAreaIds: [],
        started: false,
        frameId: null,
        scrollFrameId: null
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
      scheduleAreaSelectionAutoScroll()
    }

    const handlePointerUp = (event: PointerEvent): void => {
      if (!dragRef.current) {
        return
      }
      event.preventDefault()
      finishAreaSelectionDrag(event)
    }

    const handleScroll = (event: Event): void => {
      const state = dragRef.current
      if (!state) {
        return
      }
      const board = boardRef.current
      const target = event.target
      if (board && target instanceof Node && !board.contains(target)) {
        return
      }
      // Why: lane scrolling changes every card's viewport rect while the drag
      // is still active. Refresh before the next hit-test so selection follows
      // the scrolled content instead of stale pointer-down measurements.
      refreshAreaSelectionMeasurements()
      scheduleAreaSelectionDragFlush()
    }

    document.addEventListener('pointermove', handlePointerMove, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerUp, true)
    document.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerUp, true)
      document.removeEventListener('scroll', handleScroll, true)
      cancelAreaSelectionDrag()
    }
  }, [
    boardRef,
    cancelAreaSelectionDrag,
    finishAreaSelectionDrag,
    open,
    refreshAreaSelectionMeasurements,
    scheduleAreaSelectionAutoScroll,
    scheduleAreaSelectionDragFlush
  ])

  return { handleAreaSelectionPointerDown }
}
