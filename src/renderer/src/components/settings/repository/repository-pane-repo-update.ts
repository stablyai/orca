import type { ClaudeAccountBinding } from '../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { GhAccountBinding } from '../../../../../shared/github/accounts/account-binding'
import type { Repo } from '../../../../../shared/repository/repo-types'

/** Repo fields the settings pane edits; `null` clears a field across the host transport. */
export type RepositoryPaneRepoUpdate = Omit<
  Partial<Repo>,
  | 'sourceControlAi'
  | 'externalWorktreeVisibility'
  | 'ghAccount'
  | 'claudeAccount'
  | 'workspaceCleanupPolicy'
  | 'browserProfileId'
> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
  ghAccount?: GhAccountBinding | null
  claudeAccount?: ClaudeAccountBinding | null
  workspaceCleanupPolicy?: Repo['workspaceCleanupPolicy'] | null
  browserProfileId?: string | null
}
