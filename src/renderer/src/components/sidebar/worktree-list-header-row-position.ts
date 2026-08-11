import { HOST_STICKY_PINNED_HEIGHT } from './worktree-list-virtual-rows'

// Why: mirrors the sticky `top` classes on header rows in WorktreeList — a
// pinned group header sits one pixel above the viewport top, or flush beneath
// the pinned host card when a host section owns tier 1.
export const PINNED_HEADER_TOP_OFFSET_PX = -1
export const PINNED_HEADER_TOP_OFFSET_UNDER_HOST_PX = HOST_STICKY_PINNED_HEIGHT - 1

export function getPinnedHeaderTopOffsetPx(hasPinnedHost: boolean): number {
  return hasPinnedHost ? PINNED_HEADER_TOP_OFFSET_UNDER_HOST_PX : PINNED_HEADER_TOP_OFFSET_PX
}

export type HeaderRowPositionArgs = {
  /** Virtualizer offset of the row, in content space. */
  virtualStart: number
  /** True while the row holds the pinned slot, so it renders there instead. */
  isPinned: boolean
  scrollOffset: number
  pinnedTopOffsetPx: number
  /** Inter-section spacing the absolute branch adds as padding; the pinned slot
   *  drops it, so it has to be part of the comparison between the two. */
  headerTopSpacingPx: number
  /** Where the dragged header rendered when the drag began; null for every row
   *  that is not the dragged one. */
  dragAnchorTop: number | null
  /** Pointer delta for the dragged header, preview offset for its neighbours. */
  offsetY: number
}

/** Content-space top of a header row's visible content.
 *
 *  A pinned header renders at the sticky slot, not at `virtualStart`, so the
 *  dragged header has to be anchored to where it actually was — anchoring to
 *  `virtualStart` teleports it by the whole scrolled distance on the frame the
 *  drag promotes, and leaves it that far from the cursor for the rest of it. */
export function getHeaderRowRenderedTop(args: HeaderRowPositionArgs): number {
  if (args.dragAnchorTop !== null) {
    return args.dragAnchorTop + args.offsetY
  }
  if (args.isPinned) {
    // Why: sticky headers still need preview/pointer deltas during project drag.
    return args.scrollOffset + args.pinnedTopOffsetPx + args.offsetY
  }
  return args.virtualStart + args.headerTopSpacingPx + args.offsetY
}

/** The row's transform offset, which sits above the padding that re-adds the
 *  inter-section spacing — so it is the rendered top minus that spacing. */
export function getHeaderRowTransformStart(args: HeaderRowPositionArgs): number {
  return getHeaderRowRenderedTop(args) - args.headerTopSpacingPx
}
