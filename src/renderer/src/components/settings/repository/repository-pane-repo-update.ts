import type { GhAccountBinding } from '../../../../../shared/github/accounts/account-binding'
import type { RepoAgentAccounts } from '../../../../../shared/claude/project-claude-account-preference'
import type { Repo } from '../../../../../shared/repo-types'

export type RepositoryPaneRepoUpdate = Omit<
  Partial<Repo>,
  | 'sourceControlAi'
  | 'externalWorktreeVisibility'
  | 'ghAccount'
  | 'workspaceCleanupPolicy'
  | 'agentAccounts'
> & {
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
  ghAccount?: GhAccountBinding | null
  workspaceCleanupPolicy?: Repo['workspaceCleanupPolicy'] | null
  agentAccounts?: RepoAgentAccounts | null
}
