import { buildWorktreeDragPreviewOffsets } from './worktree-drag-preview-offsets'
import {
  getWorktreeSidebarBoundaryDrop,
  type WorktreeSidebarDragRect
} from './worktree-sidebar-drag-autoscroll'
import {
  getWorktreeSidebarDragReferenceY,
  getWorktreeSidebarDropAnchorId,
  resolveWorktreeSidebarDropAnchorIndex,
  type WorktreeSidebarDragGrab,
  type WorktreeSidebarDropAnchor
} from './worktree-sidebar-drag-geometry'

export type WorktreeSidebarDropPreview = {
  dropIndex: number
  dropIndicatorY: number
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
  // Hold the destination unit’s identity across card resizing instead of deciding again from moved geometry.
  dropAnchorId: string | null
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

function getWorktreeSidebarDragUnitRects(args: {
  rects: readonly WorktreeSidebarDragRect[]
  groupIds: readonly string[]
}): WorktreeSidebarDragRect[] {
  // Expanded lineage renders several child elements but moves as one parent drag unit.
  const sortedRects = [...args.rects].sort((a, b) => a.top - b.top)
  const rectByWorktreeId = new Map(sortedRects.map((rect) => [rect.worktreeId, rect]))

  return args.groupIds.flatMap((worktreeId, unitIndex) => {
    const rootRect = rectByWorktreeId.get(worktreeId)
    if (!rootRect) {
      return []
    }
    const nextRootTop =
      args.groupIds
        .slice(unitIndex + 1)
        .flatMap((nextId) => {
          const nextRect = rectByWorktreeId.get(nextId)
          return nextRect ? [nextRect.top] : []
        })
        .at(0) ?? Number.POSITIVE_INFINITY
    const unitBottom = sortedRects.reduce(
      (bottom, rect) =>
        rect.top >= rootRect.top && rect.top < nextRootTop ? Math.max(bottom, rect.bottom) : bottom,
      rootRect.bottom
    )
    return [
      {
        worktreeId,
        groupIndex: unitIndex,
        top: rootRect.top,
        bottom: unitBottom
      }
    ]
  })
}

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

/** Mark the replayed insertion gap, not a displaced card’s old top; only no-op drops need the fallback. */
function getWorktreeSidebarDropIndicatorY(args: {
  rects: readonly WorktreeSidebarDragRect[]
  dropIndex: number
  placeholderTop: number | null
  activeRect: WorktreeSidebarDragRect | null
}): number {
  if (args.placeholderTop !== null) {
    return Math.max(0, args.placeholderTop - 3)
  }
  // For a no-op, leave the indicator on the dragged card’s own top edge.
  if (args.activeRect) {
    return Math.max(0, args.activeRect.top - 3)
  }
  const target = args.rects.find((rect) => rect.groupIndex === args.dropIndex)
  if (target) {
    return Math.max(0, target.top - 3)
  }
  const last = args.rects.at(-1)
  return last ? last.bottom + 3 : 0
}

/** Use closest projected centers so every slot remains reachable beside tall expanded cards. */
function getWorktreeSidebarClosestCenterDropIndex(args: {
  referenceY: number
  rects: readonly WorktreeSidebarDragRect[]
  activeIndex: number
}): number {
  let overIndex = args.rects[0]!.groupIndex
  let bestDistance = Number.POSITIVE_INFINITY
  for (const rect of args.rects) {
    const distance = Math.abs((rect.top + rect.bottom) / 2 - args.referenceY)
    if (distance < bestDistance) {
      bestDistance = distance
      overIndex = rect.groupIndex
    }
  }
  // Dropping onto a slot below the dragged card means landing after it.
  return overIndex > args.activeIndex ? overIndex + 1 : overIndex
}

function getWorktreeSidebarPointerDropIndex(args: {
  referenceY: number
  rects: readonly WorktreeSidebarDragRect[]
}): number {
  for (const rect of args.rects) {
    if (args.referenceY < (rect.top + rect.bottom) / 2) {
      return rect.groupIndex
    }
  }
  return args.rects.at(-1)!.groupIndex + 1
}

export function computeWorktreeSidebarDropPreview(args: {
  pointerY: number
  containerTop: number
  scrollTop: number
  rects: readonly WorktreeSidebarDragRect[]
  groupIds: readonly string[]
  draggedIds: readonly string[]
  draggingWorktreeId?: string | null
  fallbackGap?: number
  // Reuse the measured preview grab offset; native drags have none and fall back to the pointer.
  grab?: WorktreeSidebarDragGrab | null
  // Hold the destination while the pointer stays still so card resizing cannot change the target.
  anchor?: WorktreeSidebarDropAnchor | null
}): WorktreeSidebarDropPreview | null {
  const rects = getWorktreeSidebarDragUnitRects({
    rects: args.rects,
    groupIds: args.groupIds
  })
  if (rects.length === 0 || args.groupIds.length === 0) {
    return null
  }

  const localY = args.pointerY - args.containerTop + args.scrollTop
  const activeGroupIndex = args.draggingWorktreeId
    ? args.groupIds.indexOf(args.draggingWorktreeId)
    : -1
  const activeRect =
    activeGroupIndex >= 0
      ? (rects.find((rect) => rect.worktreeId === args.draggingWorktreeId) ?? null)
      : null
  const referenceY = getWorktreeSidebarDragReferenceY({
    localY,
    grab: args.grab ?? null,
    activeRect
  })

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

  const heldIndex = args.anchor
    ? resolveWorktreeSidebarDropAnchorIndex({ anchor: args.anchor, groupIds: args.groupIds })
    : null
  let dropIndex: number
  if (heldIndex !== null) {
    dropIndex = heldIndex
  } else if (boundaryDrop.kind === 'drop') {
    dropIndex = boundaryDrop.dropIndex
  } else if (activeGroupIndex >= 0) {
    dropIndex = getWorktreeSidebarClosestCenterDropIndex({
      referenceY,
      rects,
      activeIndex: activeGroupIndex
    })
  } else {
    dropIndex = getWorktreeSidebarPointerDropIndex({ referenceY, rects })
  }

  const { offsets, placeholderTop } = buildWorktreeDragPreviewOffsets({
    groupIds: args.groupIds,
    draggedIds: args.draggedIds,
    draggingWorktreeId: args.draggingWorktreeId,
    draggedPreviewHeight: args.grab?.height,
    fallbackGap: args.fallbackGap,
    dropIndex,
    rects
  })
  return {
    dropIndex,
    dropIndicatorY: getWorktreeSidebarDropIndicatorY({
      rects,
      dropIndex,
      placeholderTop,
      activeRect
    }),
    previewOffsetsByWorktreeId: offsets,
    dropAnchorId: getWorktreeSidebarDropAnchorId({ groupIds: args.groupIds, dropIndex })
  }
}
