import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { WorkspaceStatusDefinition } from '../../../../shared/types'
import {
  clearWorkspaceKanbanSidebarDropTargetVisual,
  hasWorkspaceKanbanSidebarDropBoard,
  isWorkspaceKanbanSidebarDropPointInBoard,
  updateWorkspaceKanbanSidebarDropTargetVisual
} from './workspace-kanban-sidebar-drop'
import { updateSidebarDragPreviewPosition } from './worktree-sidebar-pointer-drag-dom'
import type {
  WorktreeSidebarDropPreview,
  WorktreeSidebarStatusDropTarget
} from './worktree-sidebar-drop-preview'
import {
  areWorktreeDragPreviewOffsetsEqual,
  EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  getPointerDropStatusTarget,
  shouldPreferSidebarStatusDropTarget,
  updateLatestWorktreeStatusDropTarget,
  type WorktreePointerDrag,
  type WorktreeRowDragState
} from './worktree-list-drag-model'

type StatusTarget = WorktreeSidebarStatusDropTarget & { lineageParentId: string | null }
type Args = {
  worktreePointerDragRef: MutableRefObject<WorktreePointerDrag | null>
  scrollRef: MutableRefObject<HTMLDivElement | null>
  clearWorktreeDrag: () => void
  refreshWorktreeDragSession: () => boolean
  workspaceBoardOpen: boolean
  onWorkspaceBoardDragPreviewStart: () => void
  onWorkspaceBoardDragPreviewCommit: () => void
  shouldShowWorkspaceBoardDropIndicator: (
    worktreeIds: readonly string[],
    status: NonNullable<WorktreeSidebarStatusDropTarget['status']>
  ) => boolean
  getEligibleLineageDropTarget: (
    target: StatusTarget,
    draggedIds: readonly string[]
  ) => StatusTarget
  computeWorktreeDrop: (pointerY: number) => WorktreeSidebarDropPreview | null
  computeWorktreeStatusDrop: (args: {
    pointerY: number
    status: NonNullable<WorktreeSidebarStatusDropTarget['status']>
    draggedIds: readonly string[]
  }) => WorktreeSidebarDropPreview | null
  setDragOverStatus: Dispatch<SetStateAction<WorktreeSidebarStatusDropTarget['status']>>
  setPinDragOver: Dispatch<SetStateAction<boolean>>
  setWorktreeDragState: Dispatch<SetStateAction<WorktreeRowDragState>>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}

export function useWorktreePointerDragFlush(args: Args): () => void {
  const {
    worktreePointerDragRef,
    scrollRef,
    clearWorktreeDrag,
    refreshWorktreeDragSession,
    workspaceBoardOpen,
    onWorkspaceBoardDragPreviewStart,
    onWorkspaceBoardDragPreviewCommit,
    shouldShowWorkspaceBoardDropIndicator,
    getEligibleLineageDropTarget,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    setDragOverStatus,
    setPinDragOver,
    setWorktreeDragState,
    workspaceStatuses
  } = args

  return useCallback(() => {
    const drag = worktreePointerDragRef.current
    if (!drag) {
      return
    }
    drag.frameId = null
    if (!drag.active || !drag.preview) {
      return
    }
    updateSidebarDragPreviewPosition({
      preview: drag.preview,
      pointerX: drag.currentX,
      pointerY: drag.currentY,
      offsetX: drag.previewOffsetX,
      offsetY: drag.previewOffsetY
    })
    if (!refreshWorktreeDragSession()) {
      clearWorktreeDrag()
      return
    }
    // Why: show the board preview as soon as a card drag begins so the drop target is visible up front, not only at the sidebar edge.
    if (
      !drag.workspaceBoardDragPreviewRequested &&
      !workspaceBoardOpen &&
      !hasWorkspaceKanbanSidebarDropBoard()
    ) {
      drag.workspaceBoardDragPreviewRequested = true
      onWorkspaceBoardDragPreviewStart()
    }
    const boardTarget = updateWorkspaceKanbanSidebarDropTargetVisual({
      x: drag.currentX,
      y: drag.currentY,
      shouldShowDropIndicator: (target) =>
        Boolean(
          target.status &&
          shouldShowWorkspaceBoardDropIndicator(drag.reorderDraggedIds, target.status)
        )
    })
    drag.latestBoardDropTarget = { target: boardTarget, x: drag.currentX, y: drag.currentY }
    if (isWorkspaceKanbanSidebarDropPointInBoard(drag.currentX, drag.currentY)) {
      onWorkspaceBoardDragPreviewCommit()
    }
    if (boardTarget.status || boardTarget.isPinDrop) {
      drag.latestStatusDropTarget = null
      setDragOverStatus(null)
      setPinDragOver(false)
      setWorktreeDragState((prev) =>
        prev.dropIndex === null &&
        prev.dropIndicatorY === null &&
        prev.pointerY === drag.currentY &&
        prev.previewOffsetsByWorktreeId.size === 0
          ? prev
          : {
              ...prev,
              dropIndex: null,
              dropIndicatorY: null,
              previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
              pointerY: drag.currentY
            }
      )
      return
    }

    const sidebarContainer = scrollRef.current
    const preferredStatusTarget = getEligibleLineageDropTarget(
      sidebarContainer
        ? getPointerDropStatusTarget({
            container: sidebarContainer,
            x: drag.currentX,
            y: drag.currentY
          })
        : { status: null, isPinDrop: false, lineageParentId: null },
      drag.draggedIds
    )
    if (preferredStatusTarget.lineageParentId) {
      updateLatestWorktreeStatusDropTarget(drag, preferredStatusTarget, null)
      clearWorkspaceKanbanSidebarDropTargetVisual()
      setDragOverStatus(null)
      setPinDragOver(false)
      setWorktreeDragState((prev) =>
        prev.dropIndex === null &&
        prev.dropIndicatorY === null &&
        prev.pointerY === drag.currentY &&
        prev.previewOffsetsByWorktreeId.size === 0
          ? prev
          : {
              ...prev,
              dropIndex: null,
              dropIndicatorY: null,
              previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
              pointerY: drag.currentY
            }
      )
      return
    }
    if (
      shouldPreferSidebarStatusDropTarget({
        sourceGroupKey: drag.sourceGroupKey,
        target: preferredStatusTarget,
        workspaceStatuses
      })
    ) {
      const statusDrop = preferredStatusTarget.status
        ? computeWorktreeStatusDrop({
            pointerY: drag.currentY,
            status: preferredStatusTarget.status,
            draggedIds: drag.reorderDraggedIds
          })
        : null
      if (statusDrop) {
        updateLatestWorktreeStatusDropTarget(drag, preferredStatusTarget, statusDrop)
        clearWorkspaceKanbanSidebarDropTargetVisual()
        setDragOverStatus(null)
        setPinDragOver(false)
        setWorktreeDragState((prev) =>
          prev.dropIndex === statusDrop.dropIndex &&
          prev.dropIndicatorY === statusDrop.dropIndicatorY &&
          prev.pointerY === drag.currentY &&
          areWorktreeDragPreviewOffsetsEqual(
            prev.previewOffsetsByWorktreeId,
            statusDrop.previewOffsetsByWorktreeId
          )
            ? prev
            : { ...prev, ...statusDrop, pointerY: drag.currentY }
        )
        return
      }
      updateLatestWorktreeStatusDropTarget(drag, preferredStatusTarget, statusDrop)
      setDragOverStatus(preferredStatusTarget.status)
      setPinDragOver(preferredStatusTarget.isPinDrop)
      setWorktreeDragState((prev) =>
        prev.dropIndex === null &&
        prev.dropIndicatorY === null &&
        prev.pointerY === drag.currentY &&
        prev.previewOffsetsByWorktreeId.size === 0
          ? prev
          : {
              ...prev,
              dropIndex: null,
              dropIndicatorY: null,
              previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
              pointerY: drag.currentY
            }
      )
      return
    }

    const drop = computeWorktreeDrop(drag.currentY)
    if (!drop) {
      const target = preferredStatusTarget
      const statusDrop = target.status
        ? computeWorktreeStatusDrop({
            pointerY: drag.currentY,
            status: target.status,
            draggedIds: drag.reorderDraggedIds
          })
        : null
      if (statusDrop) {
        updateLatestWorktreeStatusDropTarget(drag, target, statusDrop)
        clearWorkspaceKanbanSidebarDropTargetVisual()
        setDragOverStatus(null)
        setPinDragOver(false)
        setWorktreeDragState((prev) =>
          prev.dropIndex === statusDrop.dropIndex &&
          prev.dropIndicatorY === statusDrop.dropIndicatorY &&
          prev.pointerY === drag.currentY &&
          areWorktreeDragPreviewOffsetsEqual(
            prev.previewOffsetsByWorktreeId,
            statusDrop.previewOffsetsByWorktreeId
          )
            ? prev
            : { ...prev, ...statusDrop, pointerY: drag.currentY }
        )
        return
      }
      updateLatestWorktreeStatusDropTarget(drag, target, statusDrop)
      setDragOverStatus(target.status)
      setPinDragOver(target.isPinDrop)
      setWorktreeDragState((prev) =>
        prev.dropIndex === null &&
        prev.dropIndicatorY === null &&
        prev.pointerY === drag.currentY &&
        prev.previewOffsetsByWorktreeId.size === 0
          ? prev
          : {
              ...prev,
              dropIndex: null,
              dropIndicatorY: null,
              previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
              pointerY: drag.currentY
            }
      )
      return
    }
    drag.latestStatusDropTarget = null
    clearWorkspaceKanbanSidebarDropTargetVisual()
    setDragOverStatus(null)
    setPinDragOver(false)
    setWorktreeDragState((prev) =>
      prev.dropIndex === drop.dropIndex &&
      prev.dropIndicatorY === drop.dropIndicatorY &&
      prev.pointerY === drag.currentY &&
      areWorktreeDragPreviewOffsetsEqual(
        prev.previewOffsetsByWorktreeId,
        drop.previewOffsetsByWorktreeId
      )
        ? prev
        : { ...prev, ...drop, pointerY: drag.currentY }
    )
  }, [
    clearWorktreeDrag,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    onWorkspaceBoardDragPreviewStart,
    refreshWorktreeDragSession,
    onWorkspaceBoardDragPreviewCommit,
    shouldShowWorkspaceBoardDropIndicator,
    getEligibleLineageDropTarget,
    scrollRef,
    setDragOverStatus,
    setPinDragOver,
    setWorktreeDragState,
    worktreePointerDragRef,
    workspaceBoardOpen,
    workspaceStatuses
  ])
}
