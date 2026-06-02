export const SIDEBAR_TREE_INDENT = 18
export const WORKTREE_SECTION_HEADER_PADDING_LEFT = 6
export const PROJECT_GROUP_HEADER_BASE_PADDING = 10
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
  return (groupSteps + clampDepth(args.lineageDepth)) * SIDEBAR_TREE_INDENT
}
