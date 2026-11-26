export type WorktreeCardDisplaySettings = {
  /** Experimental card: draw the details row (Card display items) under each name unless explicitly disabled. */
  worktreeCardDetailsRow?: boolean
  /** Hide the primary-worktree star (Compact) and badge (Detailed). Absent means show. */
  hidePrimaryWorktreeMarker?: boolean
  /** Left step in px between a worktree row and its project. Absent means 18. */
  worktreeIndentPx?: number
}

export const DEFAULT_WORKTREE_INDENT_PX = 18
export const MAX_WORKTREE_INDENT_PX = 64

export function normalizeWorktreeIndentPx(value: unknown): number {
  const step =
    typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_WORKTREE_INDENT_PX
  return Math.max(0, Math.min(MAX_WORKTREE_INDENT_PX, Math.floor(step)))
}
