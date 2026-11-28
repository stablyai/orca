import type { GhAccountBinding } from '../../../../../shared/github/accounts/account-binding'
import type { RepoAgentAccounts } from '../../../../../shared/claude/project-claude-account-preference'
import type { Repo } from '../../../../../shared/repository/repo-types'

/** Repo fields the settings pane edits; `null` clears a field across the host transport. */
export type RepositoryPaneRepoUpdate = Omit<
  Partial<Repo>,
  | 'sourceControlAi'
  | 'externalWorktreeVisibility'
  | 'ghAccount'
  | 'workspaceCleanupPolicy'
  | 'agentAccounts'
  | 'browserProfileId'
> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
  ghAccount?: GhAccountBinding | null
  workspaceCleanupPolicy?: Repo['workspaceCleanupPolicy'] | null
  agentAccounts?: RepoAgentAccounts | null
  browserProfileId?: string | null
}
