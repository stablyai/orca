// Fold SSH-over-443/www aliases when comparing probed remotes with pasted URLs.

function normalizeRemoteHost(host: string): string {
  return host.trim().toLowerCase()
}

/** Fold www only for URL/remote comparison; forge identity normalizers feed persisted project keys and would re-key them on upgrade. */
export function foldWwwHostAlias(host: string): string {
  return normalizeRemoteHost(host).replace(/^www\./, '')
}

export function normalizeGitHubRemoteHost(host: string): string {
  const normalizedHost = normalizeRemoteHost(host)
  // Why: GitHub documents ssh.github.com as SSH-over-HTTPS for github.com repos.
  return normalizedHost === 'ssh.github.com' ? 'github.com' : normalizedHost
}

export function normalizeGitLabRemoteHost(host: string): string {
  const normalizedHost = normalizeRemoteHost(host)
  // Why: GitLab documents altssh.gitlab.com as SSH-over-443 for gitlab.com projects.
  return normalizedHost === 'altssh.gitlab.com' ? 'gitlab.com' : normalizedHost
}

export function normalizeBitbucketRemoteHost(host: string): string {
  const normalizedHost = normalizeRemoteHost(host)
  // Why: Bitbucket Cloud serves SSH for bitbucket.org repos from ssh.bitbucket.org.
  return normalizedHost === 'ssh.bitbucket.org' ? 'bitbucket.org' : normalizedHost
}

export function normalizeForgeWebHost(host: string): string {
  return normalizeBitbucketRemoteHost(normalizeGitLabRemoteHost(normalizeGitHubRemoteHost(host)))
}

/** Comparison-only host fold: the forge alias plus `www.`, for matching a remote to a pasted URL. */
export function foldComparableGitHubHost(host: string): string {
  return normalizeGitHubRemoteHost(foldWwwHostAlias(host))
}

export function foldComparableGitLabHost(host: string): string {
  return normalizeGitLabRemoteHost(foldWwwHostAlias(host))
}

/** Dotless hosts are unresolved OpenSSH Host aliases; remote -v cannot expand ~/.ssh/config, so mismatches remain unknown. */
export function isUnresolvedSshHostAlias(host: string): boolean {
  return !normalizeRemoteHost(host).includes('.')
}
