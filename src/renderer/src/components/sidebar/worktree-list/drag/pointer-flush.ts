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
import type {
  ShouldShowWorkspaceBoardDropIndicator,
  WorktreeDropCommitContext
} from './drop-commit-context'
import {
  applyWorktreeDropPreview,
  applyWorktreeLineageDropPreview,
  clearWorktreeDropPreview,
  NO_WORKTREE_SIDEBAR_DROP_TARGET,
  updateLatestWorktreeStatusDropTarget,
  type WorktreePointerDrag,
  type WorktreeRowDragState,
  type WorktreeSidebarLineageDropTarget
} from './row-state'

const REORDER_INTENT_DELAY_MS = 160

export type WorktreePointerDragFrameArgs = {
  drag: WorktreePointerDrag
  ctx: WorktreeDropCommitContext
  workspaceBoardOpen: boolean
  onWorkspaceBoardDragPreviewStart: () => void
  onWorkspaceBoardDragPreviewCommit: () => void
  shouldShowWorkspaceBoardDropIndicator: ShouldShowWorkspaceBoardDropIndicator
  setWorktreeDragState: React.Dispatch<React.SetStateAction<WorktreeRowDragState>>
  setDragOverStatus: (status: WorkspaceStatus | null) => void
  setPinDragOver: (pinDragOver: boolean) => void
}

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

export function flushWorktreePointerDragFrame(args: WorktreePointerDragFrameArgs): void {
  const { drag, ctx } = args
  drag.frameId = null
  if (!drag.active || !drag.preview) {
    return
  }
  delete drag.preview.dataset.worktreeSidebarNesting
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
  // Expose the board drop target when dragging starts, before the pointer reaches the sidebar edge.
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
        args.shouldShowWorkspaceBoardDropIndicator(
          drag.reorderDraggedIds,
          target.status,
          drag.draggedCopies
        )
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
    drag.reorderIntent = null
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
  const lineageParentId = preferredStatusTarget.lineageParentId
  if (lineageParentId) {
    drag.reorderIntent = null
    updateLatestWorktreeStatusDropTarget(drag, preferredStatusTarget, null)
    clearWorkspaceKanbanSidebarDropTargetVisual()
    drag.preview.dataset.worktreeSidebarNesting = 'true'
    updateSidebarDragPreviewPosition({
      preview: drag.preview,
      pointerX: drag.currentX,
      pointerY: drag.currentY,
      offsetX: drag.previewOffsetX,
      offsetY: drag.previewOffsetY
    })
    args.setDragOverStatus(null)
    args.setPinDragOver(false)
    args.setWorktreeDragState((prev) =>
      applyWorktreeLineageDropPreview(prev, lineageParentId, drag.currentY)
    )
    return
  }
  if (
    shouldPreferSidebarStatusDropTarget({
      sourceGroupKey: drag.sourceGroupKey,
      target: preferredStatusTarget,
      workspaceStatuses: ctx.workspaceStatuses
    })
  ) {
    drag.reorderIntent = null
    showStatusHoverWithoutInsertionLine(args, preferredStatusTarget)
    return
  }

  const drop = ctx.computeWorktreeDrop(drag.currentY)
  if (!drop) {
    drag.reorderIntent = null
    showStatusHoverWithoutInsertionLine(args, preferredStatusTarget)
    return
  }
  // Let the pointer cross a reorder gutter into the card before moving its target.
  let intent = drag.reorderIntent
  if (!intent || (intent.dropIndex !== drop.dropIndex && intent.pointerY !== drag.currentY)) {
    intent = {
      dropIndex: drop.dropIndex,
      pointerY: drag.currentY,
      startedAt: performance.now()
    }
  } else {
    // Autoscroll changes slots beneath a stationary pointer without renewing intent.
    intent.dropIndex = drop.dropIndex
    intent.pointerY = drag.currentY
  }
  drag.reorderIntent = intent
  if (performance.now() - intent.startedAt < REORDER_INTENT_DELAY_MS) {
    drag.latestStatusDropTarget = null
    args.setWorktreeDragState((prev) =>
      clearWorktreeDropPreview(prev, {
        pointerY: drag.currentY,
        preserveOffsets: true
      })
    )
    drag.frameId = window.requestAnimationFrame(() => flushWorktreePointerDragFrame(args))
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
