import { useState } from 'react'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { GhAccountBinding } from '../../../../../../shared/github/accounts/account-binding'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { SshGitExecution } from '../../../../../../shared/remote-runtime/ssh/ssh-git-execution'
import { RepositoryGitHubAccountSection } from './RepositoryGitHubAccountSection'
import { RepositoryGitExecutionSection } from './RepositoryGitExecutionSection'

export function RepositoryGitSettings({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (repoId: string, updates: { ghAccount?: GhAccountBinding | null }) => unknown
  forceVisible?: boolean
}): React.JSX.Element {
  const [execution, setExecution] = useState<SshGitExecution | null>(null)
  return (
    <>
      {execution === 'remote' ? (
        <RepositoryGitHubAccountSection
          repo={repo}
          updateRepo={updateRepo}
          forceVisible={forceVisible}
        />
      ) : null}
      <RepositoryGitExecutionSection
        key={`${getRepoExecutionHostId(repo)}:${repo.path}`}
        repo={repo}
        forceVisible={forceVisible}
        onExecutionChange={setExecution}
      />
    </>
  )
}
