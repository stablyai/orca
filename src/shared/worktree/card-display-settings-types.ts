export type WorktreeCardDisplaySettings = {
  /** Which worktree card the sidebar draws; `experimentalNewWorktreeCardStyle` stays in step for older clients. */
  worktreeCardStyle?: 'classic' | 'experimental-1' | 'experimental-2'
  /** 2.0 card: draw the details row (Card display items) under each name; off by default. */
  worktreeCardDetailsRow?: boolean
}
