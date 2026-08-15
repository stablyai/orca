import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'

export { getRepoHostIdentityForParts }

type RepoIdentityParts = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export function getRepoHostIdentity(repo: RepoIdentityParts): string {
  return getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
}

export function repoMatchesHostIdentity(
  repo: RepoIdentityParts,
  repoId: string,
  hostId: string
): boolean {
  return repo.id === repoId && getRepoExecutionHostId(repo) === hostId
}

export function findRepoForHost<T extends RepoIdentityParts>(
  repos: readonly T[],
  repoId: string,
  options: {
    hostId?: ExecutionHostId | (string & {}) | null
    settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  } = {}
): T | null {
  const matchingRepos = repos.filter((repo) => repo.id === repoId)
  if (matchingRepos.length === 0) {
    return null
  }

  if (options.hostId) {
    return matchingRepos.find((repo) => getRepoExecutionHostId(repo) === options.hostId) ?? null
  }

  if (matchingRepos.length === 1) {
    return matchingRepos[0]
  }

  const focusedHostId = getSettingsFocusedExecutionHostId(options.settings)
  const focusedMatches = matchingRepos.filter(
    (repo) => getRepoExecutionHostId(repo) === focusedHostId
  )
  // Why: when duplicate ids exist even within the focused host, mutating by bare
  // id would be ambiguous. Let callers surface no owner instead of guessing.
  return focusedMatches.length === 1 ? focusedMatches[0] : null
}
