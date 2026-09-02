import { useEffect } from 'react'
import type React from 'react'
import { getFullDropIndexForWorktreeDragUnit } from '../../worktree-drag-units'
import type { WorktreeSidebarDragSession } from '../../worktree-sidebar-drag-autoscroll'
import { getPointerDropStatusTarget } from './status-target'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import { NO_WORKTREE_SIDEBAR_DROP_TARGET } from './row-state'

// Why: a drop that lands outside the sidebar still belongs to the in-flight session, so the
// capture-phase document listeners commit or abandon it before anything else sees the event.
export function useWorktreeDocumentDrop(args: {
  ctx: WorktreeDropCommitContext
  worktreeDragSessionRef: React.MutableRefObject<WorktreeSidebarDragSession | null>
}): void {
  const { ctx, worktreeDragSessionRef } = args
  const { clearWorktreeDrag } = ctx

  useEffect(() => {
    const handleDocumentDrop = (event: DragEvent): void => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return
      }
      if (!ctx.refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const drop = ctx.computeWorktreeDrop(event.clientY)
      if (!drop) {
        const container = ctx.scrollRef.current
        const target = ctx.getEligibleLineageDropTarget(
          container
            ? getPointerDropStatusTarget({
                container,
                x: event.clientX,
                y: event.clientY
              })
            : NO_WORKTREE_SIDEBAR_DROP_TARGET,
          session.draggedIds
        )
        if (target.lineageParentId) {
          event.preventDefault()
          event.stopPropagation()
          ctx.commitWorktreeLineageParentDrop(session.draggedIds, target.lineageParentId)
          clearWorktreeDrag()
          return
        }
        const statusDrop = target.status
          ? ctx.computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: session.reorderDraggedIds
            })
          : null
        if (target.status && statusDrop) {
          event.preventDefault()
          event.stopPropagation()
          ctx.onMoveWorktreesToStatusAtIndex({
            worktreeIds: session.reorderDraggedIds,
            status: target.status,
            dropIndex: statusDrop.dropIndex,
            groups: ctx.worktreeDragGroups
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
      ctx.onReorderWorktrees({
        groups: ctx.worktreeDragGroups,
        sourceGroupKey: session.sourceGroupKey,
        draggedIds: session.reorderDraggedIds,
        dropIndex: getFullDropIndexForWorktreeDragUnit({
          groups: ctx.worktreeDragUnitGroups,
          sourceGroupKey: session.sourceGroupKey,
          dropIndex: drop.dropIndex
        })
      })
      ctx.clearReorderedWorktreeParents({
        draggedIds: session.draggedIds,
        sourceGroupKey: session.sourceGroupKey
      })
      clearWorktreeDrag()
    }

    document.addEventListener('drop', handleDocumentDrop, true)
    return () => document.removeEventListener('drop', handleDocumentDrop, true)
  }, [clearWorktreeDrag, ctx, worktreeDragSessionRef])

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
