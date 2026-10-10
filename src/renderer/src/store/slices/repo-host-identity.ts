import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  getSettingsFocusedExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'

export { getRepoHostIdentityForParts }

type RepoIdentityParts = Pick<
  Repo,
  'id' | 'connectionId' | 'executionHostId' | 'authoritativeExecutionHostId' | 'catalogOwnerHostId'
>

export function getRepoHostIdentity(repo: RepoIdentityParts): string {
  const hostId = getRepoExecutionHostId(repo)
  return (repo.authoritativeExecutionHostId && repo.authoritativeExecutionHostId !== hostId) ||
    (repo.catalogOwnerHostId && repo.catalogOwnerHostId !== hostId)
    ? JSON.stringify([
        repo.catalogOwnerHostId ?? hostId,
        repo.authoritativeExecutionHostId ?? hostId,
        repo.id
      ])
    : getRepoHostIdentityForParts(repo.id, hostId)
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
    authoritativeExecutionHostId?: ExecutionHostId | null
    catalogOwnerHostId?: ExecutionHostId | null
    settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  } = {}
): T | null {
  const matchingRepos = repos.filter((repo) => {
    const hostId = getRepoExecutionHostId(repo)
    const sshConnectionId = getRepoSshConnectionId(repo)
    const rawHostId =
      repo.authoritativeExecutionHostId ??
      (sshConnectionId
        ? toSshExecutionHostId(sshConnectionId)
        : parseExecutionHostId(hostId)?.kind === 'runtime'
          ? null
          : hostId)
    return (
      repo.id === repoId &&
      (!options.hostId || hostId === options.hostId) &&
      (!options.authoritativeExecutionHostId ||
        rawHostId === options.authoritativeExecutionHostId) &&
      (!options.catalogOwnerHostId ||
        (repo.catalogOwnerHostId ?? hostId) === options.catalogOwnerHostId)
    )
  })
  if (matchingRepos.length === 0) {
    return null
  }

  if (options.hostId || options.authoritativeExecutionHostId || options.catalogOwnerHostId) {
    return matchingRepos.length === 1 ? matchingRepos[0] : null
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
