import type { Repo } from '../../../shared/repo-types'
import {
  getTaskSourceRepoHostMatch,
  needsGitLabKnownHostsForGitHubMatch,
  type RepoBackedTaskSourceProvider
} from '../../../shared/task-source-repo-host-match'

/** glab's known hosts for a repo's execution context; `undefined` while still loading. */
export type GitLabKnownHostsLookup = (repo: Repo) => readonly string[] | undefined

export type TaskPageSourceRepoScope = {
  /** Selected repos this source queries. */
  repos: Repo[]
  /** Selected repos whose origin is on the other forge: never queried, listed without Retry. */
  excludedRepos: Repo[]
  /** True while a selected repo waits for glab's hosts before it can be placed. */
  pending: boolean
}

export function buildTaskPageSourceRepoScope(
  selectedRepos: readonly Repo[],
  provider: RepoBackedTaskSourceProvider,
  gitlabKnownHostsFor: GitLabKnownHostsLookup
): TaskPageSourceRepoScope {
  const repos: Repo[] = []
  const excludedRepos: Repo[] = []
  let pending = false
  for (const repo of selectedRepos) {
    const gitlabKnownHosts = gitlabKnownHostsFor(repo)
    // Why: querying now would spend a GitHub resolve on a repo glab may already place on GitLab.
    if (
      provider === 'github' &&
      gitlabKnownHosts === undefined &&
      needsGitLabKnownHostsForGitHubMatch(repo)
    ) {
      pending = true
      continue
    }
    if (getTaskSourceRepoHostMatch(repo, provider, gitlabKnownHosts ?? []) === 'mismatch') {
      excludedRepos.push(repo)
    } else {
      repos.push(repo)
    }
  }
  return { repos, excludedRepos, pending }
}
