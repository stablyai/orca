/**
 * The single GitLab instance Orca routes through. Shared so the settings UI
 * normalizes exactly what the main process persists and matches remotes with.
 */

/** A GitLab instance is opt-in; an empty setting disables GitLab routing. */
export function normalizeGitLabUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }
  try {
    const url = new URL(value.trim())
    if (
      !['http:', 'https:'].includes(url.protocol.toLowerCase()) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return ''
    }
    url.pathname = ''
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return ''
  }
}

export function gitLabHostFromUrl(value: unknown): string {
  const normalized = normalizeGitLabUrl(value)
  return normalized ? new URL(normalized).host : ''
}
