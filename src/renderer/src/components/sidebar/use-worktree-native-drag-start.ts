import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { WorkspaceStatus } from '../../../../shared/types'
import type { WorktreeDragGroup } from './worktree-manual-order'
import {
  getWorktreeSidebarDragAutoscroll,
  getWorktreeSidebarDragRectsForGroup,
  type WorktreeSidebarDragPoint,
  type WorktreeSidebarDragSession
} from './worktree-sidebar-drag-autoscroll'
import { getWorktreeSidebarDragGrab } from './worktree-sidebar-drag-geometry'
import type { WorktreeSidebarDropPreview } from './worktree-sidebar-drop-preview'
import {
  areWorktreeDragPreviewOffsetsEqual,
  EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  getPointerDropStatusTarget,
  type WorktreeRowDragState
} from './worktree-list-drag-model'

type Args = {
  worktreeNativeAutoscrollFrameIdRef: MutableRefObject<number | null>
  worktreeNativeAutoscrollLastFrameTimeRef: MutableRefObject<number | null>
  worktreeNativeLatestPointRef: MutableRefObject<WorktreeSidebarDragPoint | null>
  scrollRef: MutableRefObject<HTMLDivElement | null>
  worktreeDragSessionRef: MutableRefObject<WorktreeSidebarDragSession | null>
  cancelWorktreeNativeAutoscroll: () => void
  markScrollMovement: () => void
  refreshWorktreeDragSession: () => boolean
  clearWorktreeDrag: () => void
  computeWorktreeDrop: (pointerY: number) => WorktreeSidebarDropPreview | null
  computeWorktreeStatusDrop: (args: {
    pointerY: number
    status: WorkspaceStatus
    draggedIds: readonly string[]
  }) => WorktreeSidebarDropPreview | null
  setWorktreeDragState: Dispatch<SetStateAction<WorktreeRowDragState>>
  worktreeDragGroups: readonly WorktreeDragGroup[]
  getReorderDraggedIds: (ids: readonly string[]) => readonly string[]
  getReorderUnitDraggedIds: (sourceGroupKey: string, ids: readonly string[]) => readonly string[]
}

type Result = {
  startWorktreeNativeAutoscroll: () => void
  handleWorktreeCardDragStart: (
    event: React.DragEvent<HTMLDivElement>,
    worktreeId: string,
    draggedIds: readonly string[]
  ) => void
}

export function useWorktreeNativeDragStart(args: Args): Result {
  const {
    worktreeNativeAutoscrollFrameIdRef,
    worktreeNativeAutoscrollLastFrameTimeRef,
    worktreeNativeLatestPointRef,
    scrollRef,
    worktreeDragSessionRef,
    cancelWorktreeNativeAutoscroll,
    markScrollMovement,
    refreshWorktreeDragSession,
    clearWorktreeDrag,
    computeWorktreeDrop,
    computeWorktreeStatusDrop,
    setWorktreeDragState,
    worktreeDragGroups,
    getReorderDraggedIds,
    getReorderUnitDraggedIds
  } = args
  const runWorktreeNativeAutoscrollFrame = useCallback(
    (frameTime: number) => {
      worktreeNativeAutoscrollFrameIdRef.current = null
      const point = worktreeNativeLatestPointRef.current
      const container = scrollRef.current
      const session = worktreeDragSessionRef.current
      if (!point || !container || !session) {
        cancelWorktreeNativeAutoscroll()
        return
      }
      const previousFrameTime = worktreeNativeAutoscrollLastFrameTimeRef.current ?? frameTime
      worktreeNativeAutoscrollLastFrameTimeRef.current = frameTime
      const autoscroll = getWorktreeSidebarDragAutoscroll({
        point,
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
        const drop = computeWorktreeDrop(point.clientY)
        if (!drop) {
          const target = getPointerDropStatusTarget({
            container,
            x: point.clientX,
            y: point.clientY
          })
          const statusDrop = target.status
            ? computeWorktreeStatusDrop({
                pointerY: point.clientY,
                status: target.status,
                draggedIds: session.reorderDraggedIds
              })
            : null
          if (statusDrop) {
            setWorktreeDragState((prev) =>
              prev.dropIndex === statusDrop.dropIndex &&
              prev.dropIndicatorY === statusDrop.dropIndicatorY &&
              areWorktreeDragPreviewOffsetsEqual(
                prev.previewOffsetsByWorktreeId,
                statusDrop.previewOffsetsByWorktreeId
              )
                ? prev
                : { ...prev, ...statusDrop, pointerY: point.clientY }
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
        } else {
          setWorktreeDragState((prev) =>
            prev.dropIndex === drop.dropIndex &&
            prev.dropIndicatorY === drop.dropIndicatorY &&
            areWorktreeDragPreviewOffsetsEqual(
              prev.previewOffsetsByWorktreeId,
              drop.previewOffsetsByWorktreeId
            )
              ? prev
              : { ...prev, ...drop, pointerY: point.clientY }
          )
        }
      }
      worktreeNativeAutoscrollFrameIdRef.current = window.requestAnimationFrame(
        runWorktreeNativeAutoscrollFrame
      )
    },
    [
      cancelWorktreeNativeAutoscroll,
      clearWorktreeDrag,
      computeWorktreeDrop,
      computeWorktreeStatusDrop,
      markScrollMovement,
      refreshWorktreeDragSession,
      scrollRef,
      setWorktreeDragState,
      worktreeDragSessionRef,
      worktreeNativeAutoscrollFrameIdRef,
      worktreeNativeAutoscrollLastFrameTimeRef,
      worktreeNativeLatestPointRef
    ]
  )
  const startWorktreeNativeAutoscroll = useCallback(() => {
    if (worktreeNativeAutoscrollFrameIdRef.current !== null) {
      return
    }
    worktreeNativeAutoscrollLastFrameTimeRef.current = null
    worktreeNativeAutoscrollFrameIdRef.current = window.requestAnimationFrame(
      runWorktreeNativeAutoscrollFrame
    )
  }, [
    runWorktreeNativeAutoscrollFrame,
    worktreeNativeAutoscrollFrameIdRef,
    worktreeNativeAutoscrollLastFrameTimeRef
  ])
  const handleWorktreeCardDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, worktreeId: string, draggedIds: readonly string[]) => {
      const sourceGroupKey =
        worktreeDragGroups.find((group) => group.worktreeIds.includes(worktreeId))?.key ?? null
      if (!sourceGroupKey) {
        return
      }
      const reorderDraggedIds = getReorderDraggedIds(draggedIds)
      const reorderUnitDraggedIds = getReorderUnitDraggedIds(sourceGroupKey, reorderDraggedIds)
      const rects = scrollRef.current
        ? getWorktreeSidebarDragRectsForGroup(scrollRef.current, sourceGroupKey)
        : []
      const sourceRect = event.currentTarget.getBoundingClientRect()
      worktreeDragSessionRef.current = {
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
    [
      getReorderDraggedIds,
      getReorderUnitDraggedIds,
      scrollRef,
      setWorktreeDragState,
      worktreeDragGroups,
      worktreeDragSessionRef
    ]
  )
  return { startWorktreeNativeAutoscroll, handleWorktreeCardDragStart }
}
