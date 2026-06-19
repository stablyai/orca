import { buildWorktreeDragPreviewOffsets } from './worktree-manual-order'
import {
  getWorktreeSidebarBoundaryDrop,
  type WorktreeSidebarDragRect
} from './worktree-sidebar-drag-autoscroll'

export type WorktreeSidebarDropPreview = {
  dropIndex: number
  dropIndicatorY: number
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
  lineageParentId?: string
}

export type WorktreeSidebarStatusDropTarget = {
  status: string | null
  isPinDrop: boolean
}

export type WorktreeSidebarTrackedStatusDropTarget = {
  target: WorktreeSidebarStatusDropTarget & { lineageParentId: string | null }
  preview: WorktreeSidebarDropPreview | null
  x: number
  y: number
}

const STATUS_DROP_TARGET_FALLBACK_TOLERANCE_PX = 6

function hasWorktreeSidebarStatusDropTarget(
  target: WorktreeSidebarStatusDropTarget & { lineageParentId?: string | null }
): boolean {
  return target.isPinDrop || target.status !== null || (target.lineageParentId ?? null) !== null
}

export function resolveWorktreeSidebarStatusDropCommitTarget(args: {
  currentTarget: WorktreeSidebarStatusDropTarget & { lineageParentId?: string | null }
  currentPreview: WorktreeSidebarDropPreview | null
  latestTrackedTarget: WorktreeSidebarTrackedStatusDropTarget | null
  x: number
  y: number
}): {
  target: WorktreeSidebarStatusDropTarget & { lineageParentId?: string | null }
  preview: WorktreeSidebarDropPreview | null
} {
  if (hasWorktreeSidebarStatusDropTarget(args.currentTarget)) {
    return { target: args.currentTarget, preview: args.currentPreview }
  }
  const latest = args.latestTrackedTarget
  if (!latest || !hasWorktreeSidebarStatusDropTarget(latest.target)) {
    return { target: args.currentTarget, preview: args.currentPreview }
  }
  const distance = Math.hypot(args.x - latest.x, args.y - latest.y)
  return distance <= STATUS_DROP_TARGET_FALLBACK_TOLERANCE_PX
    ? { target: latest.target, preview: latest.preview }
    : { target: args.currentTarget, preview: args.currentPreview }
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
