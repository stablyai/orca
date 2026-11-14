export type WorktreeAccountPinSettings = {
  /** Worker accounts (#9496): a worktree pinned to an account launches Claude there whatever the selection; worktreeId → accountId. */
  claudeAccountPinsByWorktree?: Record<string, string>
  /** The same for Codex: its launches in that worktree use the account's own CODEX_HOME. */
  codexAccountPinsByWorktree?: Record<string, string>
}

export type PinnableAgent = 'claude' | 'codex'

/** The account an agent's host launches in this workspace are pinned to; pins never cover WSL. */
export function workspacePinnedAccount(
  settings: WorktreeAccountPinSettings,
  agent: string,
  location: { workspaceId: string; wslDistro: string | null }
): string | undefined {
  if (location.wslDistro !== null) {
    return undefined
  }
  const pins =
    agent === 'claude'
      ? settings.claudeAccountPinsByWorktree
      : agent === 'codex'
        ? settings.codexAccountPinsByWorktree
        : undefined
  return pins?.[location.workspaceId]
}
