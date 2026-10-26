import type { WorktreeSidebarDragRect } from './worktree-sidebar-drag-autoscroll'

export type WorktreeSidebarDragGrab = {
  // Distance from the dragged unit's top to the grab point, captured at drag start.
  offsetY: number
  height: number
}

export type WorktreeSidebarDropAnchor = {
  // Identity of the unit the dragged card inserts before; null means end-of-group.
  beforeWorktreeId: string | null
  pointerY: number
  scrollTop: number
}

// Why: sub-pixel pointer jitter and scroll rounding must not count as intent.
const ANCHOR_REEVALUATE_EPSILON_PX = 0.5

/** Hit-test the projected card center so placement stays consistent regardless of where a tall card was grabbed. */
export function getWorktreeSidebarDragReferenceY(args: {
  localY: number
  grab: WorktreeSidebarDragGrab | null
  activeRect: WorktreeSidebarDragRect | null
}): number {
  if (!args.grab) {
    return args.localY
  }
  const height =
    args.grab.height > 0
      ? args.grab.height
      : args.activeRect
        ? args.activeRect.bottom - args.activeRect.top
        : 0
  return args.localY - args.grab.offsetY + height / 2
}

/** Hold target identity until pointer/scroll movement; keep geometry live so resize previews and hit tests still agree. */
export function shouldReevaluateWorktreeSidebarDropAnchor(args: {
  anchor: WorktreeSidebarDropAnchor | null
  pointerY: number
  scrollTop: number
}): boolean {
  if (!args.anchor) {
    return true
  }
  return (
    Math.abs(args.anchor.pointerY - args.pointerY) > ANCHOR_REEVALUATE_EPSILON_PX ||
    Math.abs(args.anchor.scrollTop - args.scrollTop) > ANCHOR_REEVALUATE_EPSILON_PX
  )
}

/** Resolve the held target in the current layout; a removed target returns null for fresh hit-testing. */
export function resolveWorktreeSidebarDropAnchorIndex(args: {
  anchor: WorktreeSidebarDropAnchor
  groupIds: readonly string[]
}): number | null {
  if (args.anchor.beforeWorktreeId === null) {
    return args.groupIds.length
  }
  const targetIndex = args.groupIds.indexOf(args.anchor.beforeWorktreeId)
  return targetIndex !== -1 ? targetIndex : null
}

export function getWorktreeSidebarDropAnchorId(args: {
  groupIds: readonly string[]
  dropIndex: number
}): string | null {
  return args.groupIds[args.dropIndex] ?? null
}

/** Reuse the preview’s measured grab offset; unmeasured rows fall back to bare-pointer hit tests. */
export function getWorktreeSidebarDragGrab(args: {
  offsetY: number
  height: number
}): WorktreeSidebarDragGrab | null {
  if (!Number.isFinite(args.offsetY) || !Number.isFinite(args.height) || args.height <= 0) {
    return null
  }
  return {
    offsetY: Math.min(Math.max(args.offsetY, 0), args.height),
    height: args.height
  }
}
