// Share github.com/GHES detection across cache identity, quota scoping and execution routing.
export function isDefaultGitHubHost(host?: string): boolean {
  return !host?.trim() || host.trim().toLowerCase() === 'github.com'
}

// Include GHES hosts to prevent same-name collisions; omit github.com to preserve legacy keys.
export function githubRepoIdentityKey(repo: {
  owner: string
  repo: string
  host?: string
}): string {
  const slug = `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
  const host = repo.host?.trim().toLowerCase()
  return host && !isDefaultGitHubHost(host) ? `${host}/${slug}` : slug
}

// Recover host scope for callers retaining only keys: three segments imply a host because owner/repo cannot contain /.
// Undefined means github.com, so unresolved keys must not be passed here.
export function githubHostFromIdentityKey(key: string | null | undefined): string | undefined {
  const segments = key?.split('/') ?? []
  return segments.length === 3 ? segments[0] : undefined
}
