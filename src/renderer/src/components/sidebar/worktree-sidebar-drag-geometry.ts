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

/**
 * Why: the pointer is not what the user is placing — the card is. Hit-testing the
 * bare pointer makes the same visual placement resolve differently depending on
 * where the card was grabbed, which is the "unnatural" part with tall expanded
 * agent cards: grab one near its bottom and it drops a slot late.
 *
 * Project the dragged card from the pointer and compare its center instead, so
 * the drop follows where the card actually sits.
 */
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

/**
 * Why: cards resize constantly mid-drag — agent statuses stream in and expansion
 * panels animate open — so re-deciding the slot from geometry every frame lets a
 * card growing under a still pointer move the drop target with zero input.
 *
 * Hold the *decision* (insert before this card) rather than the *geometry* it was
 * made from. Re-deriving that identity against live rects each frame keeps the
 * indicator and row previews on one honest coordinate space, while only real
 * pointer or scroll movement can pick a different neighbour. Freezing the rects
 * instead — the previous approach — kept the target stable but let hit testing
 * and rendering describe two different layouts at once.
 */
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

/**
 * Resolve a held anchor back to a drop index in the current layout. Returns null
 * when the anchored card is gone (deleted, filtered, or unmounted by
 * virtualization), so the caller falls back to a fresh geometric decision.
 */
export function resolveWorktreeSidebarDropAnchorIndex(args: {
  anchor: WorktreeSidebarDropAnchor
  rects: readonly WorktreeSidebarDragRect[]
}): number | null {
  if (args.anchor.beforeWorktreeId === null) {
    return args.rects.length
  }
  const target = args.rects.find((rect) => rect.worktreeId === args.anchor.beforeWorktreeId)
  return target ? target.groupIndex : null
}

export function getWorktreeSidebarDropAnchorId(args: {
  rects: readonly WorktreeSidebarDragRect[]
  dropIndex: number
}): string | null {
  return args.rects.find((rect) => rect.groupIndex === args.dropIndex)?.worktreeId ?? null
}

/**
 * Where inside the dragged card the pointer grabbed it. The floating drag preview
 * is a fixed-size clone of the source row, so these are exactly the numbers that
 * place it on screen — reusing them keeps hit testing agreeing with what the user
 * sees. Returns null for an unmeasured row, degrading to bare-pointer hit testing
 * rather than to a wrong offset.
 */
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
