import type { ClaudeAccountBinding } from '../../../../../shared/agent-accounts/claude/claude-account-binding'
import type { GhAccountBinding } from '../../../../../shared/github/accounts/account-binding'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { RepositoryClaudeAccountSection } from './claude-account/RepositoryClaudeAccountSection'
import { RepositoryGitHubAccountSection } from './source-control/RepositoryGitHubAccountSection'

type RepositoryAccountSectionsProps = {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { ghAccount?: GhAccountBinding | null; claudeAccount?: ClaudeAccountBinding | null }
  ) => unknown
  forceVisible?: boolean
}

/** The accounts this project's GitHub calls and Claude chats run on. */
export function RepositoryAccountSections(
  props: RepositoryAccountSectionsProps
): React.JSX.Element {
  return (
    <>
      <RepositoryGitHubAccountSection {...props} />
      <RepositoryClaudeAccountSection {...props} />
    </>
  )
}
