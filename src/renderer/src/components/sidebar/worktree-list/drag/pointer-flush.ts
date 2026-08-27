import type React from 'react'
import type { WorkspaceStatus } from '../../../../../../shared/worktree/types'
import {
  clearWorkspaceKanbanSidebarDropTargetVisual,
  hasWorkspaceKanbanSidebarDropBoard,
  isWorkspaceKanbanSidebarDropPointInBoard,
  updateWorkspaceKanbanSidebarDropTargetVisual
} from '../../workspace-kanban-sidebar-drop'
import { updateSidebarDragPreviewPosition } from '../../worktree-sidebar-pointer-drag-dom'
import { getPointerDropStatusTarget, shouldPreferSidebarStatusDropTarget } from './status-target'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import {
  applyWorktreeDropPreview,
  clearWorktreeDropPreview,
  NO_WORKTREE_SIDEBAR_DROP_TARGET,
  updateLatestWorktreeStatusDropTarget,
  type WorktreePointerDrag,
  type WorktreeRowDragState,
  type WorktreeSidebarLineageDropTarget
} from './row-state'

export type WorktreePointerDragFrameArgs = {
  drag: WorktreePointerDrag
  ctx: WorktreeDropCommitContext
  workspaceBoardOpen: boolean
  onWorkspaceBoardDragPreviewStart: () => void
  onWorkspaceBoardDragPreviewCommit: () => void
  shouldShowWorkspaceBoardDropIndicator: (
    worktreeIds: readonly string[],
    status: WorkspaceStatus
  ) => boolean
  setWorktreeDragState: React.Dispatch<React.SetStateAction<WorktreeRowDragState>>
  setDragOverStatus: (status: WorkspaceStatus | null) => void
  setPinDragOver: (pinDragOver: boolean) => void
}

// Reflect a status/pin hover that has no insertion line of its own.
function showStatusHoverWithoutInsertionLine(
  args: WorktreePointerDragFrameArgs,
  target: WorktreeSidebarLineageDropTarget
): void {
  const { drag, ctx } = args
  const statusDrop = target.status
    ? ctx.computeWorktreeStatusDrop({
        pointerY: drag.currentY,
        status: target.status,
        draggedIds: drag.reorderDraggedIds
      })
    : null
  updateLatestWorktreeStatusDropTarget(drag, target, statusDrop)
  if (statusDrop) {
    clearWorkspaceKanbanSidebarDropTargetVisual()
    args.setDragOverStatus(null)
    args.setPinDragOver(false)
    args.setWorktreeDragState((prev) =>
      applyWorktreeDropPreview(prev, statusDrop, {
        pointerY: drag.currentY,
        matchPointerY: true
      })
    )
    return
  }
  args.setDragOverStatus(target.status)
  args.setPinDragOver(target.isPinDrop)
  args.setWorktreeDragState((prev) =>
    clearWorktreeDropPreview(prev, { pointerY: drag.currentY, matchPointerY: true })
  )
}

function clearInsertionLine(args: WorktreePointerDragFrameArgs): void {
  args.setDragOverStatus(null)
  args.setPinDragOver(false)
  args.setWorktreeDragState((prev) =>
    clearWorktreeDropPreview(prev, { pointerY: args.drag.currentY, matchPointerY: true })
  )
}

// One animation frame of an in-flight pointer drag: move the floating preview, then decide
// whether the pointer is over the workspace board, a status/pin section, or a reorder slot.
export function flushWorktreePointerDragFrame(args: WorktreePointerDragFrameArgs): void {
  const { drag, ctx } = args
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
  if (!ctx.refreshWorktreeDragSession()) {
    ctx.clearWorktreeDrag()
    return
  }
  // Why: show the board preview as soon as a card drag begins so the drop target is visible up front, not only at the sidebar edge.
  if (
    !drag.workspaceBoardDragPreviewRequested &&
    !args.workspaceBoardOpen &&
    !hasWorkspaceKanbanSidebarDropBoard()
  ) {
    drag.workspaceBoardDragPreviewRequested = true
    args.onWorkspaceBoardDragPreviewStart()
  }
  const boardTarget = updateWorkspaceKanbanSidebarDropTargetVisual({
    x: drag.currentX,
    y: drag.currentY,
    shouldShowDropIndicator: (target) =>
      Boolean(
        target.status &&
        args.shouldShowWorkspaceBoardDropIndicator(drag.reorderDraggedIds, target.status)
      )
  })
  drag.latestBoardDropTarget = {
    target: boardTarget,
    x: drag.currentX,
    y: drag.currentY
  }
  if (isWorkspaceKanbanSidebarDropPointInBoard(drag.currentX, drag.currentY)) {
    args.onWorkspaceBoardDragPreviewCommit()
  }
  if (boardTarget.status || boardTarget.isPinDrop) {
    drag.latestStatusDropTarget = null
    clearInsertionLine(args)
    return
  }

  const sidebarContainer = ctx.scrollRef.current
  const preferredStatusTarget = ctx.getEligibleLineageDropTarget(
    sidebarContainer
      ? getPointerDropStatusTarget({
          container: sidebarContainer,
          x: drag.currentX,
          y: drag.currentY
        })
      : NO_WORKTREE_SIDEBAR_DROP_TARGET,
    drag.draggedIds
  )
  if (preferredStatusTarget.lineageParentId) {
    updateLatestWorktreeStatusDropTarget(drag, preferredStatusTarget, null)
    clearWorkspaceKanbanSidebarDropTargetVisual()
    clearInsertionLine(args)
    return
  }
  if (
    shouldPreferSidebarStatusDropTarget({
      sourceGroupKey: drag.sourceGroupKey,
      target: preferredStatusTarget,
      workspaceStatuses: ctx.workspaceStatuses
    })
  ) {
    showStatusHoverWithoutInsertionLine(args, preferredStatusTarget)
    return
  }

  const drop = ctx.computeWorktreeDrop(drag.currentY)
  if (!drop) {
    showStatusHoverWithoutInsertionLine(args, preferredStatusTarget)
    return
  }
  drag.latestStatusDropTarget = null
  clearWorkspaceKanbanSidebarDropTargetVisual()
  args.setDragOverStatus(null)
  args.setPinDragOver(false)
  args.setWorktreeDragState((prev) =>
    applyWorktreeDropPreview(prev, drop, { pointerY: drag.currentY, matchPointerY: true })
  )
}
