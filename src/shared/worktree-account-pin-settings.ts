export type WorktreeAccountPinSettings = {
  /** Worker accounts (#9496): a worktree pinned to an account launches Claude there whatever the selection; worktreeId → accountId. */
  claudeAccountPinsByWorktree?: Record<string, string>
}
