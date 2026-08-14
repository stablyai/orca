import {
  hasProjectRemoteIdentity,
  isGitHubBackedRepo,
  isProjectRemoteIdentityPending
} from './project-host-setup-projection'
import { isGitRepoKind } from './repo-kind'
import type { Repo } from './types'

// Why: only GitHub-backed is known non-GitLab; self-hosted/IP stay until per-repo not_found.
export function isGitLabTaskEligibleRepo(
  repo: Pick<
    Repo,
    'id' | 'kind' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity' | 'connectionId'
  >
): boolean {
  if (!isGitRepoKind(repo)) {
    return false
  }
  if (isProjectRemoteIdentityPending(repo)) {
    return true
  }
  if (!hasProjectRemoteIdentity(repo)) {
    return false
  }
  return !isGitHubBackedRepo(repo)
}

export function getGitLabTaskEligibleRepos<T extends Repo>(repos: readonly T[]): T[] {
  return repos.filter((repo) => isGitLabTaskEligibleRepo(repo))
}
