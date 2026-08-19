import { useCallback } from 'react'
import type React from 'react'
import { getWorkspaceKanbanSidebarDropTarget } from '../../workspace-kanban-sidebar-drop'
import { getFullDropIndexForWorktreeDragUnit } from '../../worktree-drag-units'
import { getWorktreeSidebarDragRectsForGroup } from '../../worktree-sidebar-drag-autoscroll'
import { getWorktreeSidebarDragGrab } from '../../worktree-sidebar-drag-geometry'
import { getPointerDropStatusTarget } from './status-target'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import type { WorktreeDragRuntime } from './use-runtime'
import type { WorktreeDragSession } from './use-session'
import { useWorktreeNativeDragAutoscroll } from './use-native-autoscroll'
import {
  applyWorktreeDropPreview,
  clearWorktreeDropPreview,
  EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  NO_WORKTREE_SIDEBAR_DROP_TARGET
} from './row-state'

// The HTML5 drag path used by cards that start a native dragstart (board <-> sidebar transfers).
export function useWorktreeNativeDrag(args: {
  ctx: WorktreeDropCommitContext
  session: WorktreeDragSession
  runtime: WorktreeDragRuntime
  scrollRef: React.RefObject<HTMLDivElement | null>
  markScrollMovement: () => void
}) {
  const { ctx, session, runtime, scrollRef, markScrollMovement } = args
  const {
    nativeLatestPointRef,
    clearWorktreeDrag,
    setWorktreeDragState,
    setNativeLineageDropTargetId
  } = runtime

  const startWorktreeNativeAutoscroll = useWorktreeNativeDragAutoscroll({
    ctx,
    session,
    runtime,
    scrollRef,
    markScrollMovement
  })

  const handleWorktreeCardDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, worktreeId: string, draggedIds: readonly string[]) => {
      const sourceGroupKey =
        ctx.worktreeDragGroups.find((group) => group.worktreeIds.includes(worktreeId))?.key ?? null
      if (!sourceGroupKey) {
        return
      }
      const reorderDraggedIds = session.getReorderDraggedIds(draggedIds)
      const reorderUnitDraggedIds = session.getReorderUnitDraggedIds(
        sourceGroupKey,
        reorderDraggedIds
      )
      const rects = scrollRef.current
        ? getWorktreeSidebarDragRectsForGroup(scrollRef.current, sourceGroupKey)
        : []
      const sourceRect = event.currentTarget.getBoundingClientRect()
      session.worktreeDragSessionRef.current = {
        draggingWorktreeId: worktreeId,
        sourceGroupKey,
        draggedIds,
        reorderDraggedIds,
        reorderUnitDraggedIds,
        rects,
        grab: getWorktreeSidebarDragGrab({
          offsetY: event.clientY - sourceRect.top,
          height: sourceRect.height
        }),
        anchor: null
      }
      setWorktreeDragState({
        draggingWorktreeId: worktreeId,
        sourceGroupKey,
        dropIndex: null,
        dropIndicatorY: null,
        previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
        pointerY: null
      })
    },
    [ctx.worktreeDragGroups, scrollRef, session, setWorktreeDragState]
  )

  const handleWorktreeDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const dragSession = session.worktreeDragSessionRef.current
      if (!dragSession) {
        return
      }
      nativeLatestPointRef.current = { clientX: event.clientX, clientY: event.clientY }
      startWorktreeNativeAutoscroll()
      if (!session.refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const target = ctx.getEligibleLineageDropTarget(
        getPointerDropStatusTarget({
          container: event.currentTarget,
          x: event.clientX,
          y: event.clientY
        }),
        dragSession.draggedIds
      )
      if (target.lineageParentId) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setNativeLineageDropTargetId(target.lineageParentId)
        setWorktreeDragState((prev) => clearWorktreeDropPreview(prev, { pointerY: event.clientY }))
        return
      }
      setNativeLineageDropTargetId(null)

      const drop = ctx.computeWorktreeDrop(event.clientY)
      if (!drop) {
        const statusDrop = target.status
          ? ctx.computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: dragSession.reorderDraggedIds
            })
          : null
        if (statusDrop) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setWorktreeDragState((prev) =>
            applyWorktreeDropPreview(prev, statusDrop, { pointerY: event.clientY })
          )
          return
        }
        setWorktreeDragState((prev) => clearWorktreeDropPreview(prev, { pointerY: null }))
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setWorktreeDragState((prev) =>
        applyWorktreeDropPreview(prev, drop, { pointerY: event.clientY })
      )
    },
    [
      clearWorktreeDrag,
      ctx,
      nativeLatestPointRef,
      session,
      setNativeLineageDropTargetId,
      setWorktreeDragState,
      startWorktreeNativeAutoscroll
    ]
  )

  const handleWorktreeDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const dragSession = session.worktreeDragSessionRef.current
      if (!dragSession) {
        return
      }
      if (!session.refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const boardDropTarget = getWorkspaceKanbanSidebarDropTarget(event.clientX, event.clientY)
      if (boardDropTarget.status || boardDropTarget.isPinDrop) {
        clearWorktreeDrag()
        return
      }

      const container = scrollRef.current
      const target = ctx.getEligibleLineageDropTarget(
        container
          ? getPointerDropStatusTarget({
              container,
              x: event.clientX,
              y: event.clientY
            })
          : NO_WORKTREE_SIDEBAR_DROP_TARGET,
        dragSession.draggedIds
      )

      if (target.lineageParentId) {
        event.preventDefault()
        event.stopPropagation()
        ctx.commitWorktreeLineageParentDrop(dragSession.draggedIds, target.lineageParentId)
        clearWorktreeDrag()
        return
      }

      const drop = ctx.computeWorktreeDrop(event.clientY)
      if (!drop) {
        const statusDrop = target.status
          ? ctx.computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: dragSession.reorderDraggedIds
            })
          : null
        if (target.status && statusDrop) {
          event.preventDefault()
          event.stopPropagation()
          ctx.onMoveWorktreesToStatusAtIndex({
            worktreeIds: dragSession.reorderDraggedIds,
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
      event.preventDefault()
      ctx.onReorderWorktrees({
        groups: ctx.worktreeDragGroups,
        sourceGroupKey: dragSession.sourceGroupKey,
        draggedIds: dragSession.reorderDraggedIds,
        dropIndex: getFullDropIndexForWorktreeDragUnit({
          groups: ctx.worktreeDragUnitGroups,
          sourceGroupKey: dragSession.sourceGroupKey,
          dropIndex: drop.dropIndex
        })
      })
      ctx.clearReorderedWorktreeParents({
        draggedIds: dragSession.draggedIds,
        sourceGroupKey: dragSession.sourceGroupKey
      })
      clearWorktreeDrag()
    },
    [clearWorktreeDrag, ctx, scrollRef, session]
  )

  return { handleWorktreeCardDragStart, handleWorktreeDragOver, handleWorktreeDrop }
}
