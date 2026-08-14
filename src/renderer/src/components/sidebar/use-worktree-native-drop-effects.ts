import { useEffect, type MutableRefObject } from 'react'
import type { WorkspaceStatus } from '../../../../shared/types'
import type { WorktreeDragUnitGroup } from './worktree-drag-units'
import { getFullDropIndexForWorktreeDragUnit } from './worktree-drag-units'
import type { WorktreeDragGroup } from './worktree-manual-order'
import type { WorktreeSidebarDragSession } from './worktree-sidebar-drag-autoscroll'
import type {
  WorktreeSidebarDropPreview,
  WorktreeSidebarStatusDropTarget
} from './worktree-sidebar-drop-preview'
import { getPointerDropStatusTarget } from './worktree-list-drag-model'

type StatusTarget = WorktreeSidebarStatusDropTarget & { lineageParentId: string | null }
type Args = {
  worktreeDragSessionRef: MutableRefObject<WorktreeSidebarDragSession | null>
  scrollRef: MutableRefObject<HTMLDivElement | null>
  refreshWorktreeDragSession: () => boolean
  clearWorktreeDrag: () => void
  computeWorktreeDrop: (pointerY: number) => WorktreeSidebarDropPreview | null
  getEligibleLineageDropTarget: (
    target: StatusTarget,
    draggedIds: readonly string[]
  ) => StatusTarget
  commitWorktreeLineageParentDrop: (ids: readonly string[], parentId: string) => void
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
  worktreeDragGroups: readonly WorktreeDragGroup[]
  onReorderWorktrees: (args: {
    groups: readonly WorktreeDragGroup[]
    sourceGroupKey: string
    draggedIds: readonly string[]
    dropIndex: number
  }) => void
  worktreeDragUnitGroups: readonly WorktreeDragUnitGroup[]
  clearReorderedWorktreeParents: (args: {
    draggedIds: readonly string[]
    sourceGroupKey: string
  }) => void
}

export function useWorktreeNativeDropEffects(args: Args): void {
  const {
    worktreeDragSessionRef,
    scrollRef,
    refreshWorktreeDragSession,
    clearWorktreeDrag,
    computeWorktreeDrop,
    getEligibleLineageDropTarget,
    commitWorktreeLineageParentDrop,
    computeWorktreeStatusDrop,
    onMoveWorktreesToStatusAtIndex,
    worktreeDragGroups,
    onReorderWorktrees,
    worktreeDragUnitGroups,
    clearReorderedWorktreeParents
  } = args
  useEffect(() => {
    const handleDocumentDrop = (event: DragEvent): void => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return
      }
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const drop = computeWorktreeDrop(event.clientY)
      if (!drop) {
        const container = scrollRef.current
        const target = getEligibleLineageDropTarget(
          container
            ? getPointerDropStatusTarget({
                container,
                x: event.clientX,
                y: event.clientY
              })
            : { status: null, isPinDrop: false, lineageParentId: null },
          session.draggedIds
        )
        if (target.lineageParentId) {
          event.preventDefault()
          event.stopPropagation()
          commitWorktreeLineageParentDrop(session.draggedIds, target.lineageParentId)
          clearWorktreeDrag()
          return
        }
        const statusDrop = target.status
          ? computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: session.reorderDraggedIds
            })
          : null
        if (target.status && statusDrop) {
          event.preventDefault()
          event.stopPropagation()
          onMoveWorktreesToStatusAtIndex({
            worktreeIds: session.reorderDraggedIds,
            status: target.status,
            dropIndex: statusDrop.dropIndex,
            groups: worktreeDragGroups
          })
          clearWorktreeDrag()
          return
        }
        clearWorktreeDrag()
        return
      }
      // Why: pointer still inside the source group means reorder, not status move; commit here and stop the capture handler.
      event.preventDefault()
      event.stopPropagation()
      onReorderWorktrees({
        groups: worktreeDragGroups,
        sourceGroupKey: session.sourceGroupKey,
        draggedIds: session.reorderDraggedIds,
        dropIndex: getFullDropIndexForWorktreeDragUnit({
          groups: worktreeDragUnitGroups,
          sourceGroupKey: session.sourceGroupKey,
          dropIndex: drop.dropIndex
        })
      })
      clearReorderedWorktreeParents({
        draggedIds: session.draggedIds,
        sourceGroupKey: session.sourceGroupKey
      })
      clearWorktreeDrag()
    }
    document.addEventListener('drop', handleDocumentDrop, true)
    return () => document.removeEventListener('drop', handleDocumentDrop, true)
  }, [
    clearWorktreeDrag,
    clearReorderedWorktreeParents,
    commitWorktreeLineageParentDrop,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    getEligibleLineageDropTarget,
    onMoveWorktreesToStatusAtIndex,
    onReorderWorktrees,
    refreshWorktreeDragSession,
    scrollRef,
    worktreeDragSessionRef,
    worktreeDragGroups,
    worktreeDragUnitGroups
  ])

  useEffect(() => {
    const handleDocumentDragEnd = (): void => {
      if (worktreeDragSessionRef.current) {
        clearWorktreeDrag()
      }
    }
    document.addEventListener('dragend', handleDocumentDragEnd, true)
    return () => document.removeEventListener('dragend', handleDocumentDragEnd, true)
  }, [clearWorktreeDrag, worktreeDragSessionRef])

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible' && worktreeDragSessionRef.current) {
        clearWorktreeDrag()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [clearWorktreeDrag, worktreeDragSessionRef])
}
