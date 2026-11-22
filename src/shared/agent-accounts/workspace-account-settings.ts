export type WorkspaceAccountSettings = {
  /** Workspace IDs mapped to saved Codex accounts; absent IDs inherit the default. */
  codexWorkspaceAccounts?: Record<string, string>
  /** Workspace IDs mapped to saved Claude accounts; absent IDs inherit the default. */
  claudeWorkspaceAccounts?: Record<string, string>
}
