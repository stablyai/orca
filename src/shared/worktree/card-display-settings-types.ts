export type WorktreeCardDisplaySettings = {
  /** Experimental card: draw the details row (Card display items) under each name unless explicitly disabled. */
  worktreeCardDetailsRow?: boolean
  /** Hide the primary-worktree star (Compact) and badge (Detailed). Absent means show. */
  hidePrimaryWorktreeMarker?: boolean
  /** Left step in px between a worktree row and its project. Absent means 18. */
  worktreeIndentPx?: number
}
