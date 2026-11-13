export const SIDEBAR_TREE_INDENT = 18
// Why: keeps project-grouped cards reading as children after the surface inset is subtracted.
const PROJECT_WORKTREE_CARD_EXTRA_INDENT = 2
// Why: seats full-row flush-card content under the group header; smaller pullback = more indent.
export const FLUSH_CARD_CONTENT_PULLBACK = 4
// Why: the new card's status lane is 8px wider than the legacy one; pulling back keeps titles aligned.
export const NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK = 8
// Why: keeps a zero-indent flush card off the sidebar edge.
export const FLUSH_CARD_MIN_CONTENT_INSET = 2
export const WORKTREE_CARD_SURFACE_MARGIN = 4
// Why: level-1 lineage keeps the grouped-card anchor; deeper levels advance evenly, not cumulatively.
export const LINEAGE_IMMEDIATE_PARENT_STEP =
  SIDEBAR_TREE_INDENT + PROJECT_WORKTREE_CARD_EXTRA_INDENT
export const LINEAGE_NESTED_ROW_SURFACE_INSET = 0
export const LINEAGE_CHILDREN_INLINE_OFFSET =
  LINEAGE_IMMEDIATE_PARENT_STEP - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET
// Why: header icon+gap (22) vs. card margin+border+legacy lane+gap (23) minus pullback lands the title on the header label.
const GROUPED_CARD_TITLE_HEADER_LABEL_OFFSET = 3
export const PROJECT_GROUP_HEADER_BASE_PADDING = 10
// Why: shared with project headers so titles don't shift when grouping mode changes.
export const WORKTREE_SECTION_HEADER_PADDING_LEFT = PROJECT_GROUP_HEADER_BASE_PADDING
// Why: a full tree step leaves room for the parent level's indent guide left of each card edge.
export const PROJECT_GROUP_HEADER_INDENT = SIDEBAR_TREE_INDENT
export const MAX_PROJECT_GROUP_HEADER_DEPTH = 6
// Matches the header icon slot (`size-4`) so a level's guide drops from the center of its icon.
const PROJECT_GROUP_HEADER_ICON_SIZE = 16

function clampDepth(depth: number): number {
  return Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0))
}

export function getProjectGroupHeaderPaddingLeft(depth: number): number {
  return (
    PROJECT_GROUP_HEADER_BASE_PADDING +
    Math.min(clampDepth(depth), MAX_PROJECT_GROUP_HEADER_DEPTH) * PROJECT_GROUP_HEADER_INDENT
  )
}

export function getIndentGuideOffset(level: number): number {
  return getProjectGroupHeaderPaddingLeft(level) + PROJECT_GROUP_HEADER_ICON_SIZE / 2
}

export function getWorktreeCardContentIndent(args: {
  isGrouped: boolean
  groupDepth: number
  lineageDepth: number
}): number {
  const lineageIndent = clampDepth(args.lineageDepth) * SIDEBAR_TREE_INDENT
  return args.isGrouped
    ? getProjectGroupHeaderPaddingLeft(args.groupDepth) +
        GROUPED_CARD_TITLE_HEADER_LABEL_OFFSET +
        lineageIndent
    : lineageIndent
}

/** Rows in a project tree sit one level below their header, so their surface clears its guide. */
export function getProjectTreeCardDepth(args: {
  isProjectTree: boolean
  groupDepth: number
}): number {
  return args.isProjectTree ? clampDepth(args.groupDepth) + 1 : args.groupDepth
}

export function getWorktreeCardGeometry(args: {
  isGrouped: boolean
  groupDepth: number
  lineageDepth: number
}): {
  surfaceInset: number
  cardContentIndent: number
} {
  const contentIndent = getWorktreeCardContentIndent(args)
  const surfaceInset = getWorktreeCardSurfaceInset(args)
  return {
    surfaceInset,
    cardContentIndent: Math.max(0, contentIndent - surfaceInset)
  }
}

export function getWorktreeCardSurfaceInset(args: {
  isGrouped: boolean
  groupDepth: number
}): number {
  // Why: steps with group headers so each card edge keeps the same offset from its header icon.
  return args.isGrouped
    ? getProjectGroupHeaderPaddingLeft(args.groupDepth) - PROJECT_GROUP_HEADER_BASE_PADDING
    : 0
}

export function getFlushWorktreeCardPaddingLeft(
  contentIndent: number,
  applyNewCardStyleStatusLaneOffset = false
): string {
  const pullback =
    FLUSH_CARD_CONTENT_PULLBACK +
    (applyNewCardStyleStatusLaneOffset ? NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK : 0)
  return contentIndent > 0
    ? `max(${FLUSH_CARD_MIN_CONTENT_INSET}px, calc(${contentIndent}px - ${pullback}px))`
    : `${FLUSH_CARD_MIN_CONTENT_INSET}px`
}

export function getNewCardStyleParentContentMarginLeft(contentIndent: number): number {
  if (contentIndent <= 0) {
    return 0
  }

  const legacyInnerPadding = Math.max(
    FLUSH_CARD_MIN_CONTENT_INSET,
    contentIndent - FLUSH_CARD_CONTENT_PULLBACK
  )
  const newInnerPadding = Math.max(
    FLUSH_CARD_MIN_CONTENT_INSET,
    contentIndent - FLUSH_CARD_CONTENT_PULLBACK - NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK
  )
  const paddingShift = legacyInnerPadding - newInnerPadding
  const remainingShift = NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK - paddingShift
  if (remainingShift <= 0) {
    return 0
  }

  // Why: shallow rows hit the padding floor; finish with margin but never pass the inner edge.
  const rawMargin = -remainingShift
  return Math.max(-newInnerPadding, rawMargin)
}

export function getLineageChildrenInlineStyle(offset: number | string): {
  marginLeft: string
  width: string
} {
  const inlineOffset = typeof offset === 'number' ? `${offset}px` : offset
  return {
    marginLeft: inlineOffset,
    width: `calc(100% - ${inlineOffset})`
  }
}
