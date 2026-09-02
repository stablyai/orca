import { normalizeGitHubRemoteHost } from '../git-remote-host-alias'
import type { ProjectProviderIdentity } from '../project-types'
import { isDefaultGitHubHost } from './repository-identity-key'

/** Whether a bare host is GitHub or a GHES server; every other git host stays provider-neutral. */
function isGitHubRemoteHost(host: string): boolean {
  const hostname = host.toLowerCase().replace(/:\d+$/, '')
  // A generic git remote is provider-neutral. Only infer GHES when the host
  // itself carries a GitHub/GHE signal; upstream/icon metadata handles custom names.
  return (
    isDefaultGitHubHost(hostname) ||
    hostname.startsWith('github.') ||
    hostname.startsWith('github-') ||
    hostname.startsWith('ghe.') ||
    hostname.startsWith('ghe-')
  )
}

/** A GitHub identity for a parsed remote, carrying the host only off github.com; null for other hosts. */
function projectProviderIdentity(
  host: string,
  owner: string,
  repo: string
): ProjectProviderIdentity | null {
  const normalizedHost = normalizeGitHubRemoteHost(host)
  if (!isGitHubRemoteHost(normalizedHost)) {
    return null
  }
  return {
    provider: 'github',
    owner,
    repo,
    ...(!isDefaultGitHubHost(normalizedHost) ? { host: normalizedHost } : {})
  }
}

/** `owner/repo` from a remote path with `.git` stripped; null unless it has exactly two segments. */
function parseGitHubRemotePath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) {
    return null
  }
  const [owner, repoWithSuffix] = parts
  const repo = repoWithSuffix?.replace(/\.git$/i, '')
  return owner && repo ? { owner, repo } : null
}

/**
 * The GitHub identity a `host/owner/repo` canonical key names, or null for a non-GitHub host. The
 * key drops HTTP(S) ports, so prefer `parseGitHubRemoteUrl` when the URL is available.
 */
export function parseGitHubCanonicalKey(
  canonicalKey: string | undefined
): ProjectProviderIdentity | null {
  const trimmed = canonicalKey?.trim()
  if (!trimmed) {
    return null
  }
  const slash = trimmed.indexOf('/')
  if (slash <= 0) {
    return null
  }
  const host = trimmed.slice(0, slash)
  const path = parseGitHubRemotePath(trimmed.slice(slash + 1))
  return path ? projectProviderIdentity(host, path.owner, path.repo) : null
}

/**
 * The GitHub identity a remote URL names — SCP-style or any git/ssh/http(s) URL — or null when
 * the host is not a GitHub server. Keeps an HTTP(S) port, which identifies a GHES API endpoint.
 */
export function parseGitHubRemoteUrl(
  remoteUrl: string | undefined
): ProjectProviderIdentity | null {
  const trimmed = remoteUrl?.trim()
  if (!trimmed) {
    return null
  }
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch?.[1] && sshMatch[2] && sshMatch[3]) {
    return projectProviderIdentity(sshMatch[1], sshMatch[2], sshMatch[3])
  }
  try {
    const url = new URL(trimmed)
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    const path = parseGitHubRemotePath(url.pathname)
    if (!path) {
      return null
    }
    // HTTP ports identify the API endpoint; SSH/git ports are transport-only.
    const host = url.protocol === 'http:' || url.protocol === 'https:' ? url.host : url.hostname
    return projectProviderIdentity(host, path.owner, path.repo)
  } catch {
    return null
  }
}
