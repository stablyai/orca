import type { GlobalSettings, Repo, Worktree } from '../../../../shared/types'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
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

export function findRepoForHost<T extends RepoIdentityParts>(
  repos: readonly T[],
  repoId: string,
  options: {
    hostId?: ExecutionHostId | string | null
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

export function findRepoForWorktreeOwner<T extends RepoIdentityParts>(
  repos: readonly T[],
  worktree: Pick<Worktree, 'repoId' | 'hostId'>
): T | null {
  const matchingRepos = repos.filter((repo) => repo.id === worktree.repoId)
  if (matchingRepos.length === 0) {
    return null
  }

  if (worktree.hostId) {
    const explicitMatches = matchingRepos.filter(
      (repo) => getRepoExecutionHostId(repo) === worktree.hostId
    )
    return explicitMatches.length === 1 ? explicitMatches[0] : null
  }

  if (matchingRepos.length === 1) {
    return matchingRepos[0]
  }

  const localMatches = matchingRepos.filter(
    (repo) => getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
  )
  // Why: legacy worktrees predate host identity. Prefer their historical local
  // owner only when it is unique; otherwise a mutating caller must fail closed.
  return localMatches.length === 1 ? localMatches[0] : null
}
