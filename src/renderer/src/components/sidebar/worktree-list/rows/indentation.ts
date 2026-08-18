export const SIDEBAR_TREE_INDENT = 18
// Why: keeps project-grouped cards reading as children after the surface inset is subtracted.
const PROJECT_WORKTREE_CARD_EXTRA_INDENT = 2
// Why: seats full-row flush-card content under the group header; smaller pullback = more indent.
export const FLUSH_CARD_CONTENT_PULLBACK = 4
// Why: offsets the experimental card's fixed status lane so title/meta stay on the tree step.
export const NEW_CARD_STYLE_STATUS_LANE_EXTRA_PULLBACK = 6
// Why: keeps a zero-indent flush card off the sidebar edge.
export const FLUSH_CARD_MIN_CONTENT_INSET = 2
export const WORKTREE_CARD_SURFACE_MARGIN = 4
// Why: level-1 lineage keeps the grouped-card anchor; deeper levels advance evenly, not cumulatively.
export const LINEAGE_IMMEDIATE_PARENT_STEP =
  SIDEBAR_TREE_INDENT + PROJECT_WORKTREE_CARD_EXTRA_INDENT
export const LINEAGE_NESTED_ROW_SURFACE_INSET = 0
export const LINEAGE_CHILDREN_INLINE_OFFSET =
  LINEAGE_IMMEDIATE_PARENT_STEP - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET
// Why: sub-tree-step surface indent preserving the compact grouped child-card rhythm.
const GROUPED_WORKTREE_CARD_SURFACE_INDENT = 14
export const PROJECT_GROUP_HEADER_BASE_PADDING = 10
// Why: shared with project headers so titles don't shift when grouping mode changes.
export const WORKTREE_SECTION_HEADER_PADDING_LEFT = PROJECT_GROUP_HEADER_BASE_PADDING
export const PROJECT_GROUP_HEADER_INDENT = 10
export const MAX_PROJECT_GROUP_HEADER_DEPTH = 6

function clampDepth(depth: number): number {
  return Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0))
}

export function getProjectGroupHeaderPaddingLeft(depth: number): number {
  return (
    PROJECT_GROUP_HEADER_BASE_PADDING +
    Math.min(clampDepth(depth), MAX_PROJECT_GROUP_HEADER_DEPTH) * PROJECT_GROUP_HEADER_INDENT
  )
}

export function getWorktreeCardContentIndent(args: {
  isGrouped: boolean
  groupDepth: number
  lineageDepth: number
}): number {
  const groupSteps = args.isGrouped ? clampDepth(args.groupDepth) + 1 : 0
  const projectCardIndent = args.isGrouped ? PROJECT_WORKTREE_CARD_EXTRA_INDENT : 0
  return (groupSteps + clampDepth(args.lineageDepth)) * SIDEBAR_TREE_INDENT + projectCardIndent
}

export function getFolderBackedRepoWorktreeCardContentIndent(args: {
  groupDepth: number
  lineageDepth: number
}): number {
  // Why: follows the compact header step of folder-scanned repo headers, not the full tree step.
  return (
    getProjectGroupHeaderPaddingLeft(args.groupDepth) +
    PROJECT_GROUP_HEADER_BASE_PADDING +
    clampDepth(args.lineageDepth) * SIDEBAR_TREE_INDENT
  )
}

export function getFolderBackedRepoWorktreeCardSurfaceInset(args: {
  groupDepth: number
  lineageDepth: number
}): number {
  const contentAnchor = getFolderBackedRepoWorktreeCardContentIndent(args)
  const genericSurfaceInset = getWorktreeCardSurfaceInset({
    isGrouped: true,
    groupDepth: args.groupDepth
  })
  const maxSurfaceInset =
    contentAnchor - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET

  // Why: caps the surface so flush-card margin/padding don't overshoot the content anchor.
  return Math.min(genericSurfaceInset, Math.max(0, maxSurfaceInset))
}

export function getFolderWorkspaceCardContentIndent(args: { groupDepth: number }): number {
  const parentGroupDepth = Math.max(0, clampDepth(args.groupDepth) - 1)
  // Why: folder workspaces are direct children of their folder group: one compact header step.
  return getProjectGroupHeaderPaddingLeft(parentGroupDepth) + PROJECT_GROUP_HEADER_INDENT
}

export function getFolderWorkspaceCardSurfaceInset(args: {
  isGrouped: boolean
  groupDepth: number
}): number {
  const contentAnchor = getFolderWorkspaceCardContentIndent({ groupDepth: args.groupDepth })
  const genericSurfaceInset = getWorktreeCardSurfaceInset(args)
  const maxSurfaceInset =
    contentAnchor - WORKTREE_CARD_SURFACE_MARGIN - FLUSH_CARD_MIN_CONTENT_INSET

  // Why: caps deep surfaces so flush-card margin plus minimum padding keep the anchor compact.
  return Math.min(genericSurfaceInset, Math.max(0, maxSurfaceInset))
}

export function getFolderWorkspaceRowGeometry(args: {
  experimentalNewWorktreeCardStyle: boolean
  isFolderBackedWorkspaceChild: boolean
  isGrouped: boolean
  groupDepth: number
  lineageDepth: number
}): {
  surfaceInset: number
  cardContentIndent: number
} {
  if (args.experimentalNewWorktreeCardStyle && args.isFolderBackedWorkspaceChild) {
    // Why: standalone rows get no lineage wrapper offset, so align to the folder-backed repo anchor.
    const contentAnchor = getFolderBackedRepoWorktreeCardContentIndent({
      groupDepth: args.groupDepth,
      lineageDepth: 0
    })
    const surfaceInset = getFolderBackedRepoWorktreeCardSurfaceInset({
      groupDepth: args.groupDepth,
      lineageDepth: 0
    })

    return {
      surfaceInset,
      cardContentIndent: Math.max(0, contentAnchor - surfaceInset)
    }
  }

  const contentIndent = args.isFolderBackedWorkspaceChild
    ? getFolderWorkspaceCardContentIndent({
        groupDepth: args.groupDepth
      })
    : getWorktreeCardContentIndent({
        isGrouped: args.isGrouped,
        groupDepth: args.groupDepth,
        lineageDepth: args.lineageDepth
      })
  // Why: legacy folder-scanned workspaces keep the compact anchor; other rows use the normal path.
  const surfaceInset = args.isFolderBackedWorkspaceChild
    ? getFolderWorkspaceCardSurfaceInset({
        isGrouped: true,
        groupDepth: args.groupDepth
      })
    : getWorktreeCardSurfaceInset({
        isGrouped: args.isGrouped,
        groupDepth: args.groupDepth
      })

  return {
    surfaceInset,
    cardContentIndent: Math.max(0, contentIndent - surfaceInset)
  }
}

export function getWorktreeCardSurfaceInset(args: {
  isGrouped: boolean
  groupDepth: number
}): number {
  return args.isGrouped ? clampDepth(args.groupDepth) * GROUPED_WORKTREE_CARD_SURFACE_INDENT : 0
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

export function getLineageNestedRowGeometry(args: {
  experimentalNewWorktreeCardStyle: boolean
  inheritedCardContentIndent: number
  lineageDepth: number
}): {
  surfaceInset: number
  cardContentIndent: number
  lineageChildrenInlineOffset: number
} {
  if (args.experimentalNewWorktreeCardStyle) {
    // Why: the parent card already contributes the baseline; lineage depth would double-count.
    return {
      surfaceInset: LINEAGE_NESTED_ROW_SURFACE_INSET,
      cardContentIndent: 0,
      lineageChildrenInlineOffset: LINEAGE_CHILDREN_INLINE_OFFSET
    }
  }

  const surfaceInset = getWorktreeCardSurfaceInset({
    isGrouped: true,
    groupDepth: args.lineageDepth
  })
  return {
    surfaceInset,
    cardContentIndent: Math.max(0, args.inheritedCardContentIndent - surfaceInset),
    lineageChildrenInlineOffset: LINEAGE_CHILDREN_INLINE_OFFSET
  }
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

export function getLineageEffectiveChildStart(args: {
  parentContentStart?: number
  lineageChildrenWrapperOffset: number
  nestedRowSurfaceInset: number
  cardSurfaceMargin: number
  flushCardContentInset: number
}): number {
  return (
    (args.parentContentStart ?? 0) +
    args.lineageChildrenWrapperOffset +
    args.nestedRowSurfaceInset +
    args.cardSurfaceMargin +
    args.flushCardContentInset
  )
}
