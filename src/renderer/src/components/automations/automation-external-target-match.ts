import type { ExternalAutomationTarget } from '../../../../shared/automations-types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'

// Why: connectionId alone can disagree with the repo's pinned executionHostId;
// the execution host is the authority for which Hermes target owns a repo.
export function repoMatchesExternalAutomationTarget(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>,
  target: ExternalAutomationTarget
): boolean {
  const repoHostId = getRepoExecutionHostId(repo)
  if (target.type === 'local') {
    return parseExecutionHostId(repoHostId)?.kind === 'local'
  }
  return repoHostId === toSshExecutionHostId(target.connectionId)
}
