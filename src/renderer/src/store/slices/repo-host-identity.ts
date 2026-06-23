import type { GlobalSettings, Repo } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

type RepoIdentityParts = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>

export function getRepoHostIdentity(repo: RepoIdentityParts): string {
  return getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
}

export function getRepoHostIdentityForParts(repoId: string, hostId: string): string {
  // Why: host ids and repo ids can contain punctuation; NUL keeps the composite
  // key collision-free without escaping user/provider-owned strings.
  return `${hostId}\0${repoId}`
}

export function repoMatchesHostIdentity(
  repo: RepoIdentityParts,
  repoId: string,
  hostId: string
): boolean {
  return repo.id === repoId && getRepoExecutionHostId(repo) === hostId
}

export function findRepoForHost(
  repos: readonly RepoIdentityParts[],
  repoId: string,
  options: {
    hostId?: ExecutionHostId | string | null
    settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  } = {}
): RepoIdentityParts | null {
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
