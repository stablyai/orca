import type {
  ProjectGroupDragState,
  ProjectGroupHeaderDragSession
} from './project-group-header-drag-contract'
import type { ProjectGroupHeaderDrop } from './project-group-header-nesting-drop'

/** With a floating preview, slides the other rows open at the drop slot, as a workspace drag does, with the line in the gap. */
export function shiftHeaderDrop(
  floatingPreview: boolean,
  session: ProjectGroupHeaderDragSession | null,
  drop: { dropIndex: number; dropIndicatorY: number }
): { dropIndex: number; dropIndicatorY: number; previewOffsetsById?: ReadonlyMap<string, number> } {
  if (!floatingPreview || !session) {
    return drop
  }
  const source = session.headerRects.find((rect) => rect.groupId === session.groupId)
  const { dropIndex } = drop
  if (!source || dropIndex === source.headerIndex || dropIndex === source.headerIndex + 1) {
    return drop
  }
  const movingDown = dropIndex > source.headerIndex
  const height = source.bottom - source.top
  const firstShifted = movingDown ? source.headerIndex + 1 : dropIndex
  const lastShifted = movingDown ? dropIndex - 1 : source.headerIndex - 1
  const offsets = new Map<string, number>()
  for (const rect of session.headerRects) {
    if (rect.headerIndex >= firstShifted && rect.headerIndex <= lastShifted) {
      offsets.set(rect.groupId, movingDown ? -height : height)
    }
  }
  // Only the source and destination heights matter, even when intermediate rows are unmounted.
  const next = session.headerRects.find((rect) => rect.headerIndex === dropIndex)
  const previous = session.headerRects.find((rect) => rect.headerIndex === dropIndex - 1)
  const boundary = next?.top ?? previous?.bottom
  return {
    dropIndex,
    dropIndicatorY:
      boundary === undefined
        ? drop.dropIndicatorY
        : Math.max(0, boundary - (movingDown ? height : 0) - 3),
    previewOffsetsById: offsets
  }
}

export function getProjectGroupDragStateForDrop(
  floatingPreview: boolean,
  session: ProjectGroupHeaderDragSession | null,
  groupId: string,
  drop: ProjectGroupHeaderDrop | null
): ProjectGroupDragState {
  if (drop && drop.dropIndex !== null && drop.dropIndicatorY !== null) {
    const { dropIndex, dropIndicatorY } = drop
    return {
      draggingGroupId: groupId,
      ...shiftHeaderDrop(floatingPreview, session, { dropIndex, dropIndicatorY })
    }
  }
  return {
    draggingGroupId: groupId,
    dropIndex: null,
    dropIndicatorY: drop?.dropIndicatorY ?? null,
    dropTargetGroupId: drop?.nestingDrop?.parentGroupId ?? null
  }
}

export function isSameProjectGroupDragState(
  left: ProjectGroupDragState,
  right: ProjectGroupDragState
): boolean {
  return (
    left.draggingGroupId === right.draggingGroupId &&
    left.dropIndex === right.dropIndex &&
    left.dropIndicatorY === right.dropIndicatorY &&
    (left.dropTargetGroupId ?? null) === (right.dropTargetGroupId ?? null)
  )
}
