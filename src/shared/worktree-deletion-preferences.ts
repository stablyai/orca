export type WorktreeDeletionPreferences = {
  /** Worktree deletion removes the working directory, so confirmation is on by default. */
  skipDeleteWorktreeConfirm: boolean
  /** Opt-in: workspace deletion discards changes and may waive terminal-stop verification. */
  alwaysForceDeleteWorktrees?: boolean
  /** Opt-in: delete preserved local branches after workspace removal. */
  alwaysForceDeletePreservedBranches?: boolean
}
