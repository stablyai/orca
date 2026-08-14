import { useEffect, type MutableRefObject } from 'react'
import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import {
  getWorkspaceKanbanSidebarDropGroups,
  getWorkspaceKanbanSidebarDropTarget,
  isWorkspaceKanbanSidebarDropPointInBoard,
  resolveWorkspaceKanbanSidebarFullLaneDropIndex
} from './workspace-kanban-sidebar-drop'
import { resolveWorkspaceKanbanCardDropCommitTarget } from './workspace-kanban-card-pointer-drag-dom'
import {
  getFullDropIndexForWorktreeDragUnit,
  type WorktreeDragUnitGroup
} from './worktree-drag-units'
import type { WorktreeDragGroup } from './worktree-manual-order'
import {
  resolveWorktreeSidebarStatusDropCommitTarget,
  type WorktreeSidebarDropPreview,
  type WorktreeSidebarStatusDropTarget
} from './worktree-sidebar-drop-preview'
import {
  getPointerDropStatusTarget,
  shouldPreferSidebarStatusDropTarget,
  SIDEBAR_POINTER_DRAG_THRESHOLD_PX,
  type WorktreePointerDrag
} from './worktree-list-drag-model'

type StatusTarget = WorktreeSidebarStatusDropTarget & { lineageParentId: string | null }
type Args = {
  worktreePointerDragRef: MutableRefObject<WorktreePointerDrag | null>
  scrollRef: MutableRefObject<HTMLDivElement | null>
  beginWorktreePointerDrag: (drag: WorktreePointerDrag) => void
  scheduleWorktreePointerDragFrame: (drag: WorktreePointerDrag) => void
  refreshWorktreeDragSession: () => boolean
  clearWorktreeDrag: () => void
  onWorkspaceBoardDragPreviewCommit: () => void
  onPinWorktrees: (ids: readonly string[]) => void
  onDropWorktreesOnWorkspaceBoard: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
    groups: readonly WorktreeDragGroup[]
  }) => void
  getEligibleLineageDropTarget: (
    target: StatusTarget,
    draggedIds: readonly string[]
  ) => StatusTarget
  commitWorktreeLineageParentDrop: (draggedIds: readonly string[], parentId: string) => void
  computeWorktreeStatusDrop: (args: {
    pointerY: number
    status: WorkspaceStatus
    draggedIds: readonly string[]
  }) => WorktreeSidebarDropPreview | null
  onMoveWorktreesToStatusAtIndex: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
    groups: readonly WorktreeDragGroup[]
  }) => void
  onMoveWorktreesToStatus: (ids: readonly string[], status: WorkspaceStatus) => void
  computeWorktreeDrop: (pointerY: number) => WorktreeSidebarDropPreview | null
  onReorderWorktrees: (args: {
    groups: readonly WorktreeDragGroup[]
    sourceGroupKey: string
    draggedIds: readonly string[]
    dropIndex: number
  }) => void
  worktreeDragGroups: readonly WorktreeDragGroup[]
  worktreeDragUnitGroups: readonly WorktreeDragUnitGroup[]
  clearReorderedWorktreeParents: (args: {
    draggedIds: readonly string[]
    sourceGroupKey: string
  }) => void
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}

export function useWorktreePointerDragCommit(args: Args): void {
  const {
    worktreePointerDragRef,
    scrollRef,
    beginWorktreePointerDrag,
    scheduleWorktreePointerDragFrame,
    refreshWorktreeDragSession,
    clearWorktreeDrag,
    onWorkspaceBoardDragPreviewCommit,
    onPinWorktrees,
    onDropWorktreesOnWorkspaceBoard,
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatusAtIndex,
    onMoveWorktreesToStatus,
    computeWorktreeDrop,
    onReorderWorktrees,
    worktreeDragGroups,
    worktreeDragUnitGroups,
    clearReorderedWorktreeParents,
    workspaceStatuses
  } = args

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      drag.currentX = event.clientX
      drag.currentY = event.clientY
      if (!drag.active) {
        const distance = Math.hypot(drag.currentX - drag.startX, drag.currentY - drag.startY)
        if (distance < SIDEBAR_POINTER_DRAG_THRESHOLD_PX) {
          return
        }
        beginWorktreePointerDrag(drag)
      }
      event.preventDefault()
      event.stopPropagation()
      scheduleWorktreePointerDragFrame(drag)
    }

    const handlePointerUp = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      drag.currentX = event.clientX
      drag.currentY = event.clientY
      if (!drag.active) {
        worktreePointerDragRef.current = null
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const boardDropTarget = resolveWorkspaceKanbanCardDropCommitTarget({
        currentTarget: getWorkspaceKanbanSidebarDropTarget(event.clientX, event.clientY),
        latestTrackedTarget: drag.latestBoardDropTarget,
        x: event.clientX,
        y: event.clientY
      })
      if (isWorkspaceKanbanSidebarDropPointInBoard(event.clientX, event.clientY)) {
        onWorkspaceBoardDragPreviewCommit()
      }
      if (boardDropTarget.isPinDrop) {
        onPinWorktrees(drag.draggedIds)
      } else if (boardDropTarget.status) {
        onDropWorktreesOnWorkspaceBoard({
          worktreeIds: drag.reorderDraggedIds,
          status: boardDropTarget.status,
          // Why: the target counts rendered cards, but the groups are the full
          // lane. Board search can make those two differ.
          dropIndex: resolveWorkspaceKanbanSidebarFullLaneDropIndex(
            boardDropTarget.status,
            boardDropTarget.dropIndex
          ),
          groups: getWorkspaceKanbanSidebarDropGroups()
        })
      } else {
        const preferredStatusTarget = getEligibleLineageDropTarget(
          scrollRef.current
            ? getPointerDropStatusTarget({
                container: scrollRef.current,
                x: event.clientX,
                y: event.clientY
              })
            : { status: null, isPinDrop: false, lineageParentId: null },
          drag.draggedIds
        )
        if (preferredStatusTarget.lineageParentId) {
          commitWorktreeLineageParentDrop(drag.draggedIds, preferredStatusTarget.lineageParentId)
          clearWorktreeDrag()
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
                pointerY: event.clientY,
                status: preferredStatusTarget.status,
                draggedIds: drag.reorderDraggedIds
              })
            : null
          if (preferredStatusTarget.isPinDrop) {
            onPinWorktrees(drag.draggedIds)
          } else if (preferredStatusTarget.status) {
            if (statusDrop) {
              onMoveWorktreesToStatusAtIndex({
                worktreeIds: drag.reorderDraggedIds,
                status: preferredStatusTarget.status,
                dropIndex: statusDrop.dropIndex,
                groups: worktreeDragGroups
              })
            } else {
              onMoveWorktreesToStatus(drag.reorderDraggedIds, preferredStatusTarget.status)
            }
          }
          clearWorktreeDrag()
          return
        }
        const drop = computeWorktreeDrop(event.clientY)
        if (drop) {
          onReorderWorktrees({
            groups: worktreeDragGroups,
            sourceGroupKey: drag.sourceGroupKey,
            draggedIds: drag.reorderDraggedIds,
            dropIndex: getFullDropIndexForWorktreeDragUnit({
              groups: worktreeDragUnitGroups,
              sourceGroupKey: drag.sourceGroupKey,
              dropIndex: drop.dropIndex
            })
          })
          clearReorderedWorktreeParents({
            draggedIds: drag.draggedIds,
            sourceGroupKey: drag.sourceGroupKey
          })
        } else if (scrollRef.current) {
          const currentTarget = preferredStatusTarget
          const currentPreview = currentTarget.status
            ? computeWorktreeStatusDrop({
                pointerY: event.clientY,
                status: currentTarget.status,
                draggedIds: drag.reorderDraggedIds
              })
            : null
          const { target, preview: statusDrop } = resolveWorktreeSidebarStatusDropCommitTarget({
            currentTarget,
            currentPreview,
            latestTrackedTarget: drag.latestStatusDropTarget,
            x: event.clientX,
            y: event.clientY
          })
          if (target.lineageParentId) {
            commitWorktreeLineageParentDrop(drag.draggedIds, target.lineageParentId)
          } else if (target.isPinDrop) {
            onPinWorktrees(drag.draggedIds)
          } else if (target.status) {
            if (statusDrop) {
              onMoveWorktreesToStatusAtIndex({
                worktreeIds: drag.reorderDraggedIds,
                status: target.status,
                dropIndex: statusDrop.dropIndex,
                groups: worktreeDragGroups
              })
            } else {
              onMoveWorktreesToStatus(drag.reorderDraggedIds, target.status)
            }
          }
        }
      }
      clearWorktreeDrag()
    }

    const handlePointerCancel = (event: PointerEvent): void => {
      const drag = worktreePointerDragRef.current
      if (!drag || event.pointerId !== drag.pointerId) {
        return
      }
      clearWorktreeDrag()
    }
    window.addEventListener('pointermove', handlePointerMove, { capture: true })
    window.addEventListener('pointerup', handlePointerUp, { capture: true })
    window.addEventListener('pointercancel', handlePointerCancel, { capture: true })
    return () => {
      window.removeEventListener('pointermove', handlePointerMove, { capture: true })
      window.removeEventListener('pointerup', handlePointerUp, { capture: true })
      window.removeEventListener('pointercancel', handlePointerCancel, { capture: true })
    }
  }, [
    beginWorktreePointerDrag,
    clearWorktreeDrag,
    clearReorderedWorktreeParents,
    commitWorktreeLineageParentDrop,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    getEligibleLineageDropTarget,
    onMoveWorktreesToStatus,
    onMoveWorktreesToStatusAtIndex,
    onDropWorktreesOnWorkspaceBoard,
    onPinWorktrees,
    onReorderWorktrees,
    onWorkspaceBoardDragPreviewCommit,
    refreshWorktreeDragSession,
    scheduleWorktreePointerDragFrame,
    scrollRef,
    worktreePointerDragRef,
    worktreeDragGroups,
    worktreeDragUnitGroups,
    workspaceStatuses
  ])
}
