// Why: the github.com-vs-GHES boundary is the core invariant of Enterprise
// support — cache identity, quota scoping, and exec-host routing must all
// agree on it, so the predicate lives here once.
export function isDefaultGitHubHost(host?: string): boolean {
  return !host?.trim() || host.trim().toLowerCase() === 'github.com'
}

// Why: cache keys and equality checks for GitHub repos must include the host,
// or a GHES repo and a same-named github.com repo would collide. github.com is
// omitted so pre-Enterprise host-less keys stay stable.
export function githubRepoIdentityKey(repo: {
  owner: string
  repo: string
  host?: string
}): string {
  const slug = `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`
  const host = repo.host?.trim().toLowerCase()
  return host && !isDefaultGitHubHost(host) ? `${host}/${slug}` : slug
}

// Why: callers that only kept the key (not the identity it came from) still need
// its host segment to scope a second, host-less identity into the same namespace.
// `owner` and `repo` never contain `/`, so a three-segment key is host-qualified.
// `undefined` means github.com, so never pass a key that may be unresolved.
export function githubHostFromIdentityKey(key: string | null | undefined): string | undefined {
  const segments = key?.split('/') ?? []
  return segments.length === 3 ? segments[0] : undefined
}
