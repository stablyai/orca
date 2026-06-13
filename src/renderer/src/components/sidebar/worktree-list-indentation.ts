export const SIDEBAR_TREE_INDENT = 18
// Why: project-grouped cards need to read as children even after the card
// surface inset is subtracted, while lineage rows keep the base tree step.
const PROJECT_WORKTREE_CARD_EXTRA_INDENT = 2
// Why: flush cards span the full row, so their content is pulled back from the
// raw tree indent to sit under the group header. A smaller pullback nudges
// content rightward for clearer nesting; this is the knob to tune that gap.
export const FLUSH_CARD_CONTENT_PULLBACK = 4
// Why: even at zero indent a flush card keeps this minimal left inset so its
// surface never sits hard against the sidebar edge.
export const FLUSH_CARD_MIN_CONTENT_INSET = 2
// Why: grouped workspace cards should move their surface inward without using
// the full tree step, preserving the existing compact child-card rhythm.
const GROUPED_WORKTREE_CARD_SURFACE_INDENT = 14
export const PROJECT_GROUP_HEADER_BASE_PADDING = 10
// Why: workspace/status headers and project headers occupy the same sidebar
// row role, so their titles should not shift when switching grouping modes.
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

export function getWorktreeCardSurfaceInset(args: {
  isGrouped: boolean
  groupDepth: number
}): number {
  return args.isGrouped ? clampDepth(args.groupDepth) * GROUPED_WORKTREE_CARD_SURFACE_INDENT : 0
}

export function getFlushWorktreeCardPaddingLeft(contentIndent: number): string {
  return contentIndent > 0
    ? `max(${FLUSH_CARD_MIN_CONTENT_INSET}px, calc(${contentIndent}px - ${FLUSH_CARD_CONTENT_PULLBACK}px))`
    : `${FLUSH_CARD_MIN_CONTENT_INSET}px`
}
