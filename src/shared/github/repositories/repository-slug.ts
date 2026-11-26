const REPOSITORY_SLUG_RE = /^[A-Za-z0-9._-]+$/

export function isGitHubRepositorySlug(value: unknown): value is string {
  return (
    typeof value === 'string' && REPOSITORY_SLUG_RE.test(value) && value !== '.' && value !== '..'
  )
}
