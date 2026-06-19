import type { WorktreeDragGroup } from './worktree-manual-order'
import type { WorktreeDragUnitGroup } from './worktree-drag-units'

const EDGE_ZONE_PX = 56
const MAX_OUTSIDE_EDGE_PX = 48
const MAX_SCROLL_SPEED_PX_PER_SECOND = 960
const MAX_FRAME_MS = 32
const DROP_BOUNDS_PADDING_PX = 8

export type WorktreeSidebarDragPoint = {
  clientX: number
  clientY: number
}

export type WorktreeSidebarDragRect = {
  worktreeId: string
  groupIndex: number
  top: number
  bottom: number
}

export type WorktreeSidebarDragSession = {
  draggingWorktreeId: string
  sourceGroupKey: string
  draggedIds: readonly string[]
  reorderDraggedIds: readonly string[]
  reorderUnitDraggedIds: readonly string[]
  rects: readonly WorktreeSidebarDragRect[]
}

export type WorktreeSidebarAutoscrollResult = {
  scrollTop: number
}

export type WorktreeSidebarBoundaryDropResult =
  | {
      kind: 'drop'
      dropIndex: number
      indicatorY: number
    }
  | { kind: 'inside' }
  | { kind: 'outside' }

export function getWorktreeSidebarDragAutoscroll(args: {
  point: WorktreeSidebarDragPoint
  containerRect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  elapsedMs: number
}): WorktreeSidebarAutoscrollResult | null {
  const { point, containerRect } = args
  if (point.clientX < containerRect.left || point.clientX > containerRect.right) {
    return null
  }

  const maxScrollTop = Math.max(0, args.scrollHeight - args.clientHeight)
  if (maxScrollTop <= 0) {
    return null
  }

  const scrollTop = Math.max(0, Math.min(maxScrollTop, args.scrollTop))
  const elapsedMs = Math.max(0, Math.min(MAX_FRAME_MS, args.elapsedMs))
  if (elapsedMs <= 0) {
    return null
  }

  const edge = getVerticalEdgeIntensity(point.clientY, containerRect)
  if (!edge) {
    return null
  }

  const nextScrollTop = Math.max(
    0,
    Math.min(
      maxScrollTop,
      scrollTop +
        edge.direction * edge.intensity * MAX_SCROLL_SPEED_PX_PER_SECOND * (elapsedMs / 1000)
    )
  )
  return nextScrollTop === scrollTop ? null : { scrollTop: nextScrollTop }
}

export function getWorktreeSidebarBoundaryDrop(args: {
  localY: number
  firstRect: WorktreeSidebarDragRect
  lastRect: WorktreeSidebarDragRect
  sourceGroupSize: number
}): WorktreeSidebarBoundaryDropResult {
  if (args.localY < args.firstRect.top - DROP_BOUNDS_PADDING_PX) {
    if (args.firstRect.groupIndex === 0 && args.localY >= args.firstRect.top - EDGE_ZONE_PX) {
      return {
        kind: 'drop',
        dropIndex: 0,
        indicatorY: Math.max(0, args.firstRect.top - 3)
      }
    }
    return { kind: 'outside' }
  }

  if (args.localY > args.lastRect.bottom + DROP_BOUNDS_PADDING_PX) {
    const lastGroupIndex = args.sourceGroupSize - 1
    if (
      args.lastRect.groupIndex === lastGroupIndex &&
      args.localY <= args.lastRect.bottom + EDGE_ZONE_PX
    ) {
      return {
        kind: 'drop',
        dropIndex: args.sourceGroupSize,
        indicatorY: args.lastRect.bottom + 3
      }
    }
    return { kind: 'outside' }
  }

  return { kind: 'inside' }
}

export function getWorktreeSidebarDragRectsForGroup(
  container: HTMLElement,
  groupKey: string
): WorktreeSidebarDragRect[] {
  const containerRect = container.getBoundingClientRect()
  const rects: WorktreeSidebarDragRect[] = []
  container.querySelectorAll<HTMLElement>('[data-worktree-drag-id]').forEach((element) => {
    if (element.getAttribute('data-worktree-drag-group-key') !== groupKey) {
      return
    }
    const worktreeId = element.getAttribute('data-worktree-drag-id')
    const rawGroupIndex = element.getAttribute('data-worktree-drag-group-index')
    const groupIndex = rawGroupIndex === null ? Number.NaN : Number(rawGroupIndex)
    if (!worktreeId || !Number.isFinite(groupIndex)) {
      return
    }
    const rect = element.getBoundingClientRect()
    const virtualRow = element.closest<HTMLElement>('[data-worktree-virtual-row]')
    const virtualRowStart = getWorktreeVirtualRowStart(virtualRow)
    const top =
      virtualRow && virtualRowStart !== null
        ? virtualRowStart + rect.top - virtualRow.getBoundingClientRect().top
        : rect.top - containerRect.top + container.scrollTop
    rects.push({
      worktreeId,
      groupIndex,
      // Why: drop previews animate via row transforms. Anchor hit-testing to
      // the virtual row's static slot so animated offsets cannot perturb it.
      top,
      bottom: top + rect.height
    })
  })
  rects.sort((a, b) => a.top - b.top)
  return rects
}

function getWorktreeVirtualRowStart(virtualRow: HTMLElement | null): number | null {
  if (!virtualRow) {
    return null
  }
  const rawStart = virtualRow.getAttribute('data-worktree-virtual-row-start')
  if (rawStart === null) {
    return null
  }
  const start = Number(rawStart)
  return Number.isFinite(start) ? start : null
}

export function refreshWorktreeSidebarDragSession(args: {
  session: WorktreeSidebarDragSession
  groups: readonly WorktreeDragGroup[]
  unitGroups: readonly WorktreeDragUnitGroup[]
  rects: readonly WorktreeSidebarDragRect[]
}): WorktreeSidebarDragSession | null {
  const sourceGroup = args.groups.find((group) => group.key === args.session.sourceGroupKey)
  if (!sourceGroup || !sourceGroup.worktreeIds.includes(args.session.draggingWorktreeId)) {
    return null
  }

  const sourceUnitGroup = args.unitGroups.find((group) => group.key === args.session.sourceGroupKey)
  if (!sourceUnitGroup) {
    return null
  }

  const sourceUnitIds = new Set(sourceUnitGroup.worktreeIds)
  if (args.session.reorderUnitDraggedIds.some((worktreeId) => !sourceUnitIds.has(worktreeId))) {
    return null
  }

  return { ...args.session, rects: args.rects }
}

function getVerticalEdgeIntensity(
  clientY: number,
  containerRect: Pick<DOMRect, 'top' | 'bottom'>
): { direction: -1 | 1; intensity: number } | null {
  if (clientY < containerRect.top - MAX_OUTSIDE_EDGE_PX) {
    return null
  }
  if (clientY > containerRect.bottom + MAX_OUTSIDE_EDGE_PX) {
    return null
  }
  if (clientY <= containerRect.top + EDGE_ZONE_PX) {
    return {
      direction: -1,
      intensity: Math.min(1, (containerRect.top + EDGE_ZONE_PX - clientY) / EDGE_ZONE_PX)
    }
  }
  if (clientY >= containerRect.bottom - EDGE_ZONE_PX) {
    return {
      direction: 1,
      intensity: Math.min(1, (clientY - (containerRect.bottom - EDGE_ZONE_PX)) / EDGE_ZONE_PX)
    }
  }
  return null
}
