import type { WorktreeSidebarDragRect } from './worktree-sidebar-drag-autoscroll'

function getDragRowSignature(rects: readonly WorktreeSidebarDragRect[]): string {
  return rects.map((rect) => `${rect.worktreeId}@${rect.groupIndex}`).join('|')
}

/**
 * Why: the drop index comes from comparing the pointer against row midpoints,
 * and sidebar cards keep resizing mid-drag — agent statuses stream in and
 * expansion panels animate open underneath the pointer. Measuring afresh every
 * frame lets a card that grows while the pointer barely moves shove those
 * midpoints past it, so one nudge teleports the insertion line several slots.
 *
 * Hold the geometry captured when the drag reached this row set, so only pointer
 * movement can change the drop target. The set is held whole rather than merged
 * per row: mixing held tops with freshly measured ones would describe two
 * different layouts at once. When the rows themselves change — mounting during
 * autoscroll, or genuinely changing slot — the fresh measurement is adopted
 * wholesale so the coordinate space stays consistent.
 *
 * Only hit testing uses this; the indicator and row previews still render from
 * live geometry, so a card growing mid-drag never leaves them stale.
 */
export function holdWorktreeSidebarDragRects(args: {
  held: readonly WorktreeSidebarDragRect[] | undefined
  measured: readonly WorktreeSidebarDragRect[]
}): readonly WorktreeSidebarDragRect[] {
  if (!args.held || args.held.length === 0) {
    return args.measured
  }
  return getDragRowSignature(args.held) === getDragRowSignature(args.measured)
    ? args.held
    : args.measured
}
