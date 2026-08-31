import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { AutomationHostTarget } from './automation-host-client'

/**
 * Runtime-host automation creation must choose from that host's repo catalog.
 * Local automation storage intentionally keeps the existing SSH-capable catalog.
 */
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
