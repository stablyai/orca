import { DEFAULT_GITLAB_HOSTS, parseGitLabProjectRef } from './gitlab-project-ref-parser'
import { getProjectProviderIdentity } from './project-host-setup-projection'
import type { Repo } from './repo-types'

/**
 * Whether a repo can belong to a repo-backed task source, judged only from what Orca
 * already stored about its remote. `unknown` keeps today's resolve-and-maybe-fail path.
 */
export type TaskSourceRepoHostMatch = 'match' | 'mismatch' | 'unknown'

export type RepoBackedTaskSourceProvider = 'github' | 'gitlab'

type RepoRemoteFields = Pick<Repo, 'upstream' | 'repoIcon' | 'gitRemoteIdentity'>
type StoredRemote = NonNullable<Repo['gitRemoteIdentity']>

function getStoredRemoteForge(
  identity: StoredRemote,
  gitlabKnownHosts: readonly string[]
): RepoBackedTaskSourceProvider | null {
  if (getProjectProviderIdentity({ gitRemoteIdentity: identity })) {
    return 'github'
  }
  const remoteUrl = typeof identity.remoteUrl === 'string' ? identity.remoteUrl : ''
  return parseGitLabProjectRef(remoteUrl, [...DEFAULT_GITLAB_HOSTS, ...gitlabKnownHosts])
    ? 'gitlab'
    : null
}

// Why: fork metadata and the GitHub avatar are both read from origin's GitHub repository.
function hasOriginGitHubMetadata(repo: RepoRemoteFields): boolean {
  return getProjectProviderIdentity({ upstream: repo.upstream, repoIcon: repo.repoIcon }) !== null
}

export function getTaskSourceRepoHostMatch(
  repo: RepoRemoteFields,
  provider: RepoBackedTaskSourceProvider,
  gitlabKnownHosts: readonly string[] = []
): TaskSourceRepoHostMatch {
  const identity = repo.gitRemoteIdentity
  const storedForge = identity ? getStoredRemoteForge(identity, gitlabKnownHosts) : null
  const originGitHubMetadata = hasOriginGitHubMetadata(repo)
  if (storedForge === provider || (provider === 'github' && originGitHubMetadata)) {
    return 'match'
  }
  // Why: the identity keeps one remote and `upstream` outranks `origin`, yet both
  // resolvers also read origin — only a known origin can rule this source out.
  const originForge =
    identity?.remoteName === 'origin' ? storedForge : originGitHubMetadata ? 'github' : null
  return originForge && originForge !== provider ? 'mismatch' : 'unknown'
}

/** True when glab's known hosts could still turn this repo's GitHub verdict into `mismatch`. */
export function needsGitLabKnownHostsForGitHubMatch(repo: RepoRemoteFields): boolean {
  const identity = repo.gitRemoteIdentity
  return (
    identity?.remoteName === 'origin' &&
    getStoredRemoteForge(identity, []) === null &&
    !hasOriginGitHubMetadata(repo)
  )
}
