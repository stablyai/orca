import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'

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
