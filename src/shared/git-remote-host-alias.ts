// Why: a remote URL can name a forge through an alias host (SSH-over-443, `www.`), and every
// comparison of a probed remote against a pasted URL must fold those to the same identity.

function normalizeRemoteHost(host: string): string {
  return host.trim().toLowerCase()
}

/**
 * Fold a `www.` prefix. Deliberately NOT part of the forge normalizers: those feed
 * `getProjectIdentityKey`, so folding there would re-key already-persisted projects on upgrade.
 * Only URL-vs-remote comparison may use it.
 */
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

/** Comparison-only host fold: the forge alias plus `www.`, for matching a remote to a pasted URL. */
export function foldComparableGitHubHost(host: string): string {
  return normalizeGitHubRemoteHost(foldWwwHostAlias(host))
}

export function foldComparableGitLabHost(host: string): string {
  return normalizeGitLabRemoteHost(foldWwwHostAlias(host))
}

/**
 * A host with no dot is an OpenSSH `Host` alias (`git@github-work:owner/repo`) that only
 * ~/.ssh/config can expand; `git remote -v` never resolves it, so it is unknown, not wrong.
 */
export function isUnresolvedSshHostAlias(host: string): boolean {
  return !normalizeRemoteHost(host).includes('.')
}
