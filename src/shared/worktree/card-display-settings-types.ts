export type WorktreeCardDisplaySettings = {
  /** Which worktree card the sidebar draws ('experimental-2' is retired and reads as 'experimental-1'); `experimentalNewWorktreeCardStyle` stays in step for older clients. */
  worktreeCardStyle?: 'classic' | 'experimental-1' | 'experimental-2'
  /** Experimental card: draw the details row (Card display items) under each name unless explicitly disabled. */
  worktreeCardDetailsRow?: boolean
}
