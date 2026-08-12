import {
  hasProjectRemoteIdentity,
  isGitHubBackedRepo,
  isProjectRemoteIdentityPending
} from './project-host-setup-projection'
import { isGitRepoKind } from './repo-kind'
import type { Repo } from './types'

/** Baseline host always treated as GitLab (matches main-process DEFAULT_GITLAB_HOSTS). */
export const DEFAULT_GITLAB_TASK_HOSTS = ['gitlab.com'] as const

function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, '')
}

/** Host from a settled remote identity (`host/group/project` key or remote URL). */
export function extractGitRemoteHost(repo: Pick<Repo, 'gitRemoteIdentity'>): string | null {
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
  if (hostnameOf(knownHost) === knownHost) {
    return hostnameOf(urlHost) === knownHost
  }
  return false
}

/** True when host matches knownHosts or a conventional GitLab hostname. */
export function isGitLabTaskHost(
  host: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_TASK_HOSTS
): boolean {
  const normalized = normalizeHost(host)
  if (!normalized) {
    return false
  }
  if (knownHosts.map(normalizeHost).some((entry) => knownHostMatches(normalized, entry))) {
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
 * Baseline GitLab task eligibility without host allowlists.
 * Why: only authoritative non-GitLab (GitHub-backed) is excluded; arbitrary
 * self-hosted/IP remotes stay until a per-repo backend not_found proves otherwise.
 */
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
