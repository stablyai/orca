import { buildWorktreeDragPreviewOffsets } from './worktree-manual-order'
import {
  getWorktreeSidebarBoundaryDrop,
  type WorktreeSidebarDragRect
} from './worktree-sidebar-drag-autoscroll'

export type WorktreeSidebarDropPreview = {
  dropIndex: number
  dropIndicatorY: number
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
}

export function computeWorktreeSidebarDropPreview(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  rects: readonly WorktreeSidebarDragRect[]
  groupIds: readonly string[]
  draggedIds: readonly string[]
}): WorktreeSidebarDropPreview | null {
  const { rects } = args
  if (rects.length === 0 || args.groupIds.length === 0) {
    return null
  }

  const localY = args.pointerY - args.containerTop + args.scrollTop
  const first = rects[0]!
  const last = rects.at(-1)!
  const boundaryDrop = getWorktreeSidebarBoundaryDrop({
    localY,
    firstRect: first,
    lastRect: last,
    sourceGroupSize: args.groupIds.length
  })
  if (boundaryDrop.kind === 'outside') {
    return null
  }

  let dropIndex = last.groupIndex + 1
  let indicatorY = last.bottom + 3
  if (boundaryDrop.kind === 'drop') {
    dropIndex = boundaryDrop.dropIndex
    indicatorY = boundaryDrop.indicatorY
  } else {
    for (const rect of rects) {
      const mid = (rect.top + rect.bottom) / 2
      if (localY < mid) {
        dropIndex = rect.groupIndex
        indicatorY = Math.max(0, rect.top - 3)
        break
      }
    }
  }
  const previewOffsetsByWorktreeId = buildWorktreeDragPreviewOffsets({
    groupIds: args.groupIds,
    draggedIds: args.draggedIds,
    dropIndex,
    rects
  })
  return { dropIndex, dropIndicatorY: indicatorY, previewOffsetsByWorktreeId }
}
