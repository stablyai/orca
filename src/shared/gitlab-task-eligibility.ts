import {
  hasProjectRemoteIdentity,
  isGitHubBackedRepo,
  isProjectRemoteIdentityPending
} from './project-host-setup-projection'
import { isGitRepoKind } from './repo-kind'
import type { Repo } from './types'

/** Hosts always treated as GitLab when the UI has no glab known-hosts list yet. */
export const DEFAULT_GITLAB_TASK_HOSTS = ['gitlab.com'] as const

function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, '')
}

/**
 * Extract the forge host from a settled git remote identity.
 * Canonical keys are `host/group/project` (no scheme); remote URLs keep the scheme.
 */
export function extractGitRemoteHost(
  repo: Pick<Repo, 'gitRemoteIdentity'>
): string | null {
  const remoteUrl = repo.gitRemoteIdentity?.remoteUrl?.trim() ?? ''
  if (remoteUrl) {
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remoteUrl)) {
      const scpLike = remoteUrl.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+)$/)
      if (scpLike?.[1]) {
        return normalizeHost(scpLike[1])
      }
    }
    try {
      const url = new URL(remoteUrl)
      if (['http:', 'https:'].includes(url.protocol.toLowerCase())) {
        return normalizeHost(url.host)
      }
      if (url.hostname) {
        return normalizeHost(url.hostname)
      }
    } catch {
      // Fall through to canonical key.
    }
  }
  const key = repo.gitRemoteIdentity?.canonicalKey?.trim() ?? ''
  if (!key) {
    return null
  }
  const slash = key.indexOf('/')
  if (slash <= 0) {
    return null
  }
  return normalizeHost(key.slice(0, slash))
}

function knownHostMatches(urlHost: string, knownHost: string): boolean {
  if (urlHost === knownHost) {
    return true
  }
  // Bare known entry matches any port on the same hostname.
  if (hostnameOf(knownHost) === knownHost) {
    return hostnameOf(urlHost) === knownHost
  }
  return false
}

/** True when the host is gitlab.com, a known glab host, or a common self-hosted GitLab name. */
export function isGitLabTaskHost(
  host: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_TASK_HOSTS
): boolean {
  const normalized = normalizeHost(host)
  if (!normalized) {
    return false
  }
  const known = knownHosts.map(normalizeHost)
  if (known.some((entry) => knownHostMatches(normalized, entry))) {
    return true
  }
  const hostname = hostnameOf(normalized)
  return (
    hostname === 'gitlab.com' ||
    hostname.startsWith('gitlab.') ||
    hostname.includes('.gitlab.')
  )
}

/**
 * Whether a repo should be queried by the GitLab task source.
 *
 * Settled GitHub-backed projects are out. Settled remotes whose host is not a
 * GitLab host (and not still pending probe) are out — that is the migrated-off
 * GitLab case in #13817. Pending identity stays in so offline SSH probes are
 * not silently dropped. Optional `knownHosts` admits self-hosted instances that
 * do not carry "gitlab" in the hostname once glab has authenticated them.
 */
export function isGitLabTaskEligibleRepo(
  repo: Pick<
    Repo,
    'id' | 'kind' | 'upstream' | 'repoIcon' | 'gitRemoteIdentity' | 'connectionId'
  >,
  knownHosts: readonly string[] = DEFAULT_GITLAB_TASK_HOSTS
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
  if (isGitHubBackedRepo(repo)) {
    return false
  }
  const host = extractGitRemoteHost(repo)
  // Upstream/icon-only GitHub identity already excluded above. A non-GitHub
  // identity with no parseable host is still unknown — keep it for main-process
  // resolution rather than hide a valid self-hosted checkout.
  if (!host) {
    return true
  }
  return isGitLabTaskHost(host, knownHosts)
}

export function getGitLabTaskEligibleRepos<T extends Repo>(
  repos: readonly T[],
  knownHosts: readonly string[] = DEFAULT_GITLAB_TASK_HOSTS
): T[] {
  return repos.filter((repo) => isGitLabTaskEligibleRepo(repo, knownHosts))
}
