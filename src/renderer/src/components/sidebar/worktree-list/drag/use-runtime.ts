import { useCallback, useMemo, useRef, useState } from 'react'
import type React from 'react'
import type { WorkspaceStatus } from '../../../../../../shared/worktree/types'
import { clearWorkspaceKanbanSidebarDropTargetVisual } from '../../workspace-kanban-sidebar-drop'
import { setSidebarPointerDragDocumentStyles } from '../../worktree-sidebar-pointer-drag-dom'
import type {
  WorktreeSidebarDragPoint,
  WorktreeSidebarDragSession
} from '../../worktree-sidebar-drag-autoscroll'
import type { WorktreeSidebarDropAnchor } from '../../worktree-sidebar-drag-geometry'
import {
  WORKTREE_ROW_DRAG_INITIAL_STATE,
  type WorktreePointerDrag,
  type WorktreeRowDragState
} from './row-state'

export type WorktreeDragRuntime = ReturnType<typeof useWorktreeDragRuntime>

export function useWorktreeDragRuntime(args: {
  worktreeDragSessionRef: React.MutableRefObject<WorktreeSidebarDragSession | null>
  statusDropAnchorsRef: React.MutableRefObject<Map<string, WorktreeSidebarDropAnchor>>
  onWorkspaceBoardDragPreviewCancel: () => void
}) {
  const { worktreeDragSessionRef, statusDropAnchorsRef, onWorkspaceBoardDragPreviewCancel } = args
  const [dragOverStatus, setDragOverStatus] = useState<WorkspaceStatus | null>(null)
  const [pinDragOver, setPinDragOver] = useState(false)
  const [nativeLineageDropTargetId, setNativeLineageDropTargetId] = useState<string | null>(null)
  const [worktreeDragState, setWorktreeDragState] = useState<WorktreeRowDragState>(
    WORKTREE_ROW_DRAG_INITIAL_STATE
  )
  const worktreePointerDragRef = useRef<WorktreePointerDrag | null>(null)
  const pointerAutoscrollFrameIdRef = useRef<number | null>(null)
  const pointerAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const nativeAutoscrollFrameIdRef = useRef<number | null>(null)
  const nativeAutoscrollLastFrameTimeRef = useRef<number | null>(null)
  const nativeLatestPointRef = useRef<WorktreeSidebarDragPoint | null>(null)
  const suppressWorktreeClickUntilRef = useRef(0)

  const cancelWorktreePointerAutoscroll = useCallback(() => {
    if (pointerAutoscrollFrameIdRef.current !== null) {
      window.cancelAnimationFrame(pointerAutoscrollFrameIdRef.current)
      pointerAutoscrollFrameIdRef.current = null
    }
    pointerAutoscrollLastFrameTimeRef.current = null
  }, [])

  const cancelWorktreeNativeAutoscroll = useCallback(() => {
    if (nativeAutoscrollFrameIdRef.current !== null) {
      window.cancelAnimationFrame(nativeAutoscrollFrameIdRef.current)
      nativeAutoscrollFrameIdRef.current = null
    }
    nativeAutoscrollLastFrameTimeRef.current = null
    nativeLatestPointRef.current = null
  }, [])

  const cleanupWorktreePointerDrag = useCallback(() => {
    const drag = worktreePointerDragRef.current
    cancelWorktreePointerAutoscroll()
    setNativeLineageDropTargetId(null)
    if (!drag) {
      return
    }
    if (drag.frameId !== null) {
      window.cancelAnimationFrame(drag.frameId)
    }
    drag.preview?.remove()
    worktreePointerDragRef.current = null
    setSidebarPointerDragDocumentStyles(false)
    setDragOverStatus(null)
    setPinDragOver(false)
    clearWorkspaceKanbanSidebarDropTargetVisual()
    onWorkspaceBoardDragPreviewCancel()
  }, [cancelWorktreePointerAutoscroll, onWorkspaceBoardDragPreviewCancel])

  const clearWorktreeDrag = useCallback(() => {
    cleanupWorktreePointerDrag()
    cancelWorktreeNativeAutoscroll()
    worktreeDragSessionRef.current = null
    statusDropAnchorsRef.current.clear()
    setWorktreeDragState(WORKTREE_ROW_DRAG_INITIAL_STATE)
  }, [
    cancelWorktreeNativeAutoscroll,
    cleanupWorktreePointerDrag,
    statusDropAnchorsRef,
    worktreeDragSessionRef
  ])

  // Keep handler-bundle identity stable for memoized cards until meaningful inputs change.
  return useMemo(
    () => ({
      dragOverStatus,
      setDragOverStatus,
      pinDragOver,
      setPinDragOver,
      nativeLineageDropTargetId,
      setNativeLineageDropTargetId,
      worktreeDragState,
      setWorktreeDragState,
      worktreePointerDragRef,
      pointerAutoscrollFrameIdRef,
      pointerAutoscrollLastFrameTimeRef,
      nativeAutoscrollFrameIdRef,
      nativeAutoscrollLastFrameTimeRef,
      nativeLatestPointRef,
      suppressWorktreeClickUntilRef,
      cancelWorktreePointerAutoscroll,
      cancelWorktreeNativeAutoscroll,
      clearWorktreeDrag
    }),
    [
      cancelWorktreeNativeAutoscroll,
      cancelWorktreePointerAutoscroll,
      clearWorktreeDrag,
      dragOverStatus,
      nativeLineageDropTargetId,
      pinDragOver,
      worktreeDragState
    ]
  )
}
