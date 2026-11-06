import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationHostTarget } from './automation-host-client'

/** Runtime creation uses that host’s repo catalog; desktop storage retains its SSH-capable catalog. */
export function getAutomationCreateRepos(
  repos: readonly Repo[],
  target: AutomationHostTarget
): Repo[] {
  if (target.kind !== 'environment') {
    return repos.filter(
      (repo) => parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'
    )
  }
  const hostId = toRuntimeExecutionHostId(target.environmentId)
  return repos.filter((repo) => getRepoExecutionHostId(repo) === hostId)
}
