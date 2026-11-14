export type WorktreeAccountPinSettings = {
  /** Worker accounts (#9496): a worktree pinned to an account launches Claude there whatever the selection; worktreeId → accountId. */
  claudeAccountPinsByWorktree?: Record<string, string>
}

/** Whether a Claude launch in this workspace runs on its pinned account; pins cover host launches only. */
export function isClaudeWorkspacePinned(
  settings: WorktreeAccountPinSettings,
  location: { workspaceId: string; wslDistro: string | null }
): boolean {
  return (
    location.wslDistro === null &&
    settings.claudeAccountPinsByWorktree?.[location.workspaceId] !== undefined
  )
}
