import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { WorkspaceStatus } from '../../../../shared/types'
import { getWorkspaceKanbanSidebarDropTarget } from './workspace-kanban-sidebar-drop'
import {
  getFullDropIndexForWorktreeDragUnit,
  type WorktreeDragUnitGroup
} from './worktree-drag-units'
import type { WorktreeDragGroup } from './worktree-manual-order'
import type {
  WorktreeSidebarDragPoint,
  WorktreeSidebarDragSession
} from './worktree-sidebar-drag-autoscroll'
import type {
  WorktreeSidebarDropPreview,
  WorktreeSidebarStatusDropTarget
} from './worktree-sidebar-drop-preview'
import {
  areWorktreeDragPreviewOffsetsEqual,
  EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  getPointerDropStatusTarget,
  type WorktreeRowDragState
} from './worktree-list-drag-model'

type StatusTarget = WorktreeSidebarStatusDropTarget & { lineageParentId: string | null }
type Args = {
  worktreeDragSessionRef: MutableRefObject<WorktreeSidebarDragSession | null>
  worktreeNativeLatestPointRef: MutableRefObject<WorktreeSidebarDragPoint | null>
  scrollRef: MutableRefObject<HTMLDivElement | null>
  startWorktreeNativeAutoscroll: () => void
  refreshWorktreeDragSession: () => boolean
  clearWorktreeDrag: () => void
  getEligibleLineageDropTarget: (target: StatusTarget, ids: readonly string[]) => StatusTarget
  setNativeLineageDropTargetId: Dispatch<SetStateAction<string | null>>
  setWorktreeDragState: Dispatch<SetStateAction<WorktreeRowDragState>>
  computeWorktreeDrop: (pointerY: number) => WorktreeSidebarDropPreview | null
  computeWorktreeStatusDrop: (args: {
    pointerY: number
    status: WorkspaceStatus
    draggedIds: readonly string[]
  }) => WorktreeSidebarDropPreview | null
  commitWorktreeLineageParentDrop: (ids: readonly string[], parentId: string) => void
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

export function useWorktreeNativeDragHandlers(args: Args): {
  handleWorktreeDragOver: (event: React.DragEvent<HTMLDivElement>) => void
  handleWorktreeDrop: (event: React.DragEvent<HTMLDivElement>) => void
} {
  const {
    worktreeDragSessionRef,
    worktreeNativeLatestPointRef,
    scrollRef,
    startWorktreeNativeAutoscroll,
    refreshWorktreeDragSession,
    clearWorktreeDrag,
    getEligibleLineageDropTarget,
    setNativeLineageDropTargetId,
    setWorktreeDragState,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    commitWorktreeLineageParentDrop,
    onMoveWorktreesToStatusAtIndex,
    worktreeDragGroups,
    onReorderWorktrees,
    worktreeDragUnitGroups,
    clearReorderedWorktreeParents
  } = args
  const handleWorktreeDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return
      }
      worktreeNativeLatestPointRef.current = { clientX: event.clientX, clientY: event.clientY }
      startWorktreeNativeAutoscroll()
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const target = getEligibleLineageDropTarget(
        getPointerDropStatusTarget({
          container: event.currentTarget,
          x: event.clientX,
          y: event.clientY
        }),
        session.draggedIds
      )
      if (target.lineageParentId) {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        setNativeLineageDropTargetId(target.lineageParentId)
        setWorktreeDragState((prev) =>
          prev.dropIndex === null &&
          prev.dropIndicatorY === null &&
          prev.previewOffsetsByWorktreeId.size === 0
            ? prev
            : {
                ...prev,
                dropIndex: null,
                dropIndicatorY: null,
                previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
                pointerY: event.clientY
              }
        )
        return
      }
      setNativeLineageDropTargetId(null)
      const drop = computeWorktreeDrop(event.clientY)
      if (!drop) {
        const statusDrop = target.status
          ? computeWorktreeStatusDrop({
              pointerY: event.clientY,
              status: target.status,
              draggedIds: session.reorderDraggedIds
            })
          : null
        if (statusDrop) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setWorktreeDragState((prev) =>
            prev.dropIndex === statusDrop.dropIndex &&
            prev.dropIndicatorY === statusDrop.dropIndicatorY &&
            areWorktreeDragPreviewOffsetsEqual(
              prev.previewOffsetsByWorktreeId,
              statusDrop.previewOffsetsByWorktreeId
            )
              ? prev
              : { ...prev, ...statusDrop, pointerY: event.clientY }
          )
          return
        }
        setWorktreeDragState((prev) =>
          prev.dropIndex === null &&
          prev.dropIndicatorY === null &&
          prev.previewOffsetsByWorktreeId.size === 0
            ? prev
            : {
                ...prev,
                dropIndex: null,
                dropIndicatorY: null,
                previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
                pointerY: null
              }
        )
        return
      }
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setWorktreeDragState((prev) =>
        prev.dropIndex === drop.dropIndex &&
        prev.dropIndicatorY === drop.dropIndicatorY &&
        areWorktreeDragPreviewOffsetsEqual(
          prev.previewOffsetsByWorktreeId,
          drop.previewOffsetsByWorktreeId
        )
          ? prev
          : { ...prev, ...drop, pointerY: event.clientY }
      )
    },
    [
      clearWorktreeDrag,
      computeWorktreeDrop,
      computeWorktreeStatusDrop,
      getEligibleLineageDropTarget,
      refreshWorktreeDragSession,
      setNativeLineageDropTargetId,
      setWorktreeDragState,
      startWorktreeNativeAutoscroll,
      worktreeDragSessionRef,
      worktreeNativeLatestPointRef
    ]
  )
  const handleWorktreeDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      const session = worktreeDragSessionRef.current
      if (!session) {
        return
      }
      if (!refreshWorktreeDragSession()) {
        clearWorktreeDrag()
        return
      }
      const boardDropTarget = getWorkspaceKanbanSidebarDropTarget(event.clientX, event.clientY)
      if (boardDropTarget.status || boardDropTarget.isPinDrop) {
        clearWorktreeDrag()
        return
      }
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
      const drop = computeWorktreeDrop(event.clientY)
      if (!drop) {
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
      event.preventDefault()
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
    },
    [
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
    ]
  )
  return { handleWorktreeDragOver, handleWorktreeDrop }
}
