import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { Worktree } from '../../../../shared/types'
import { hasWorkspaceKanbanSidebarDropBoard } from './workspace-kanban-sidebar-drop'
import {
  createSidebarDragPreview,
  isSidebarPointerDragBlocked,
  setSidebarPointerDragDocumentStyles
} from './worktree-sidebar-pointer-drag-dom'
import {
  getWorktreeSidebarDragAutoscroll,
  getWorktreeSidebarDragRectsForGroup,
  type WorktreeSidebarDragSession
} from './worktree-sidebar-drag-autoscroll'
import { getWorktreeSidebarDragGrab } from './worktree-sidebar-drag-geometry'
import {
  EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  type WorktreePointerDrag,
  type WorktreeRowDragState
} from './worktree-list-drag-model'

type Args = {
  flushWorktreePointerDrag: () => void
  worktreePointerDragRef: MutableRefObject<WorktreePointerDrag | null>
  worktreePointerAutoscrollFrameIdRef: MutableRefObject<number | null>
  worktreePointerAutoscrollLastFrameTimeRef: MutableRefObject<number | null>
  worktreeDragSessionRef: MutableRefObject<WorktreeSidebarDragSession | null>
  scrollRef: MutableRefObject<HTMLDivElement | null>
  suppressWorktreeClickUntilRef: MutableRefObject<number>
  cancelWorktreePointerAutoscroll: () => void
  clearWorktreeDrag: () => void
  markScrollMovement: () => void
  refreshWorktreeDragSession: () => boolean
  setWorktreeDragState: Dispatch<SetStateAction<WorktreeRowDragState>>
  groupKeyByRowKey: ReadonlyMap<string, string>
  workspaceBoardOpen: boolean
  onWorkspaceBoardDragPreviewStart: () => void
  noopWorkspaceBoardDragPreviewCallback: () => void
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  getReorderDraggedIds: (ids: readonly string[]) => readonly string[]
  getReorderUnitDraggedIds: (
    sourceGroupKey: string,
    draggedIds: readonly string[]
  ) => readonly string[]
}

type Result = {
  scheduleWorktreePointerDragFrame: (drag: WorktreePointerDrag) => void
  beginWorktreePointerDrag: (drag: WorktreePointerDrag) => void
  handleWorktreeRowPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    worktreeId: string,
    rowKey: string
  ) => void
  handleWorktreeRowClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void
}

export function useWorktreePointerDragController(args: Args): Result {
  const {
    flushWorktreePointerDrag,
    worktreePointerDragRef,
    worktreePointerAutoscrollFrameIdRef,
    worktreePointerAutoscrollLastFrameTimeRef,
    worktreeDragSessionRef,
    scrollRef,
    suppressWorktreeClickUntilRef,
    cancelWorktreePointerAutoscroll,
    clearWorktreeDrag,
    markScrollMovement,
    refreshWorktreeDragSession,
    setWorktreeDragState,
    groupKeyByRowKey,
    workspaceBoardOpen,
    onWorkspaceBoardDragPreviewStart,
    noopWorkspaceBoardDragPreviewCallback,
    selectedWorktreeIds,
    selectedWorktrees,
    getReorderDraggedIds,
    getReorderUnitDraggedIds
  } = args

  const scheduleWorktreePointerDragFrame = useCallback(
    (drag: WorktreePointerDrag) => {
      if (drag.frameId !== null) {
        return
      }
      drag.frameId = window.requestAnimationFrame(flushWorktreePointerDrag)
    },
    [flushWorktreePointerDrag]
  )

  const runWorktreePointerAutoscrollFrame = useCallback(
    (frameTime: number) => {
      worktreePointerAutoscrollFrameIdRef.current = null
      const drag = worktreePointerDragRef.current
      const container = scrollRef.current
      const session = worktreeDragSessionRef.current
      if (!drag?.active || !container || !session) {
        cancelWorktreePointerAutoscroll()
        return
      }
      const previousFrameTime = worktreePointerAutoscrollLastFrameTimeRef.current ?? frameTime
      worktreePointerAutoscrollLastFrameTimeRef.current = frameTime
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point: { clientX: drag.currentX, clientY: drag.currentY },
        containerRect: container.getBoundingClientRect(),
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        elapsedMs: frameTime - previousFrameTime
      })
      if (autoscroll) {
        markScrollMovement()
        container.scrollTop = autoscroll.scrollTop
        if (!refreshWorktreeDragSession()) {
          clearWorktreeDrag()
          return
        }
        scheduleWorktreePointerDragFrame(drag)
      }
      worktreePointerAutoscrollFrameIdRef.current = window.requestAnimationFrame(
        runWorktreePointerAutoscrollFrame
      )
    },
    [
      cancelWorktreePointerAutoscroll,
      clearWorktreeDrag,
      markScrollMovement,
      refreshWorktreeDragSession,
      scheduleWorktreePointerDragFrame,
      scrollRef,
      worktreeDragSessionRef,
      worktreePointerAutoscrollFrameIdRef,
      worktreePointerAutoscrollLastFrameTimeRef,
      worktreePointerDragRef
    ]
  )

  const startWorktreePointerAutoscroll = useCallback(() => {
    if (worktreePointerAutoscrollFrameIdRef.current !== null) {
      return
    }
    worktreePointerAutoscrollLastFrameTimeRef.current = null
    worktreePointerAutoscrollFrameIdRef.current = window.requestAnimationFrame(
      runWorktreePointerAutoscrollFrame
    )
  }, [
    runWorktreePointerAutoscrollFrame,
    worktreePointerAutoscrollFrameIdRef,
    worktreePointerAutoscrollLastFrameTimeRef
  ])

  const beginWorktreePointerDrag = useCallback(
    (drag: WorktreePointerDrag) => {
      const { preview, offsetX, offsetY, height } = createSidebarDragPreview({
        sourceRow: drag.sourceRow,
        pointerX: drag.currentX,
        pointerY: drag.currentY,
        draggedCount: drag.draggedIds.length
      })
      drag.active = true
      drag.preview = preview
      drag.previewOffsetX = offsetX
      drag.previewOffsetY = offsetY
      suppressWorktreeClickUntilRef.current = window.performance.now() + 500
      setSidebarPointerDragDocumentStyles(true)
      worktreeDragSessionRef.current = {
        draggingWorktreeId: drag.worktreeId,
        sourceGroupKey: drag.sourceGroupKey,
        draggedIds: drag.draggedIds,
        reorderDraggedIds: drag.reorderDraggedIds,
        reorderUnitDraggedIds: drag.reorderUnitDraggedIds,
        rects: drag.rects,
        // Why: reuse the floating preview's own offset so the hit test tracks the
        // card the user sees, not the raw pointer.
        grab: getWorktreeSidebarDragGrab({ offsetY, height }),
        anchor: null
      }
      setWorktreeDragState({
        draggingWorktreeId: drag.worktreeId,
        sourceGroupKey: drag.sourceGroupKey,
        dropIndex: null,
        dropIndicatorY: null,
        previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
        pointerY: drag.currentY
      })
      startWorktreePointerAutoscroll()
      scheduleWorktreePointerDragFrame(drag)
    },
    [
      scheduleWorktreePointerDragFrame,
      setWorktreeDragState,
      startWorktreePointerAutoscroll,
      suppressWorktreeClickUntilRef,
      worktreeDragSessionRef
    ]
  )

  const handleWorktreeRowPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, worktreeId: string, rowKey: string) => {
      if (event.button !== 0 || event.pointerType === 'touch') {
        return
      }
      const sourceRow = event.currentTarget
      if (isSidebarPointerDragBlocked(event.target, sourceRow)) {
        return
      }
      const sourceGroupKey = groupKeyByRowKey.get(rowKey)
      const container = scrollRef.current
      if (!sourceGroupKey || !container) {
        return
      }
      const rects = getWorktreeSidebarDragRectsForGroup(container, sourceGroupKey)
      const canPreviewWorkspaceBoardOnDrag =
        !workspaceBoardOpen &&
        onWorkspaceBoardDragPreviewStart !== noopWorkspaceBoardDragPreviewCallback
      if (
        rects.length <= 1 &&
        !hasWorkspaceKanbanSidebarDropBoard() &&
        !canPreviewWorkspaceBoardOnDrag
      ) {
        return
      }
      const draggedIds =
        selectedWorktreeIds.has(worktreeId) && selectedWorktrees.length > 1
          ? selectedWorktrees.map((worktree) => worktree.id)
          : [worktreeId]
      const reorderDraggedIds = getReorderDraggedIds(draggedIds)
      const reorderUnitDraggedIds = getReorderUnitDraggedIds(sourceGroupKey, reorderDraggedIds)
      worktreePointerDragRef.current = {
        pointerId: event.pointerId,
        sourceRow,
        startX: event.clientX,
        startY: event.clientY,
        currentX: event.clientX,
        currentY: event.clientY,
        worktreeId,
        draggedIds,
        reorderDraggedIds,
        reorderUnitDraggedIds,
        sourceGroupKey,
        rects,
        active: false,
        preview: null,
        previewOffsetX: 0,
        previewOffsetY: 0,
        workspaceBoardDragPreviewRequested: false,
        frameId: null,
        latestBoardDropTarget: null,
        latestStatusDropTarget: null
      }
    },
    [
      getReorderDraggedIds,
      getReorderUnitDraggedIds,
      groupKeyByRowKey,
      noopWorkspaceBoardDragPreviewCallback,
      onWorkspaceBoardDragPreviewStart,
      scrollRef,
      selectedWorktreeIds,
      selectedWorktrees,
      worktreePointerDragRef,
      workspaceBoardOpen
    ]
  )

  const handleWorktreeRowClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (window.performance.now() >= suppressWorktreeClickUntilRef.current) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    },
    [suppressWorktreeClickUntilRef]
  )

  return {
    scheduleWorktreePointerDragFrame,
    beginWorktreePointerDrag,
    handleWorktreeRowPointerDown,
    handleWorktreeRowClickCapture
  }
}
