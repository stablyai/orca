import type { GitHubRepositoryIdentity } from './pull-request-types'
/** Allow only credential-free HTTP(S) links before handing API-supplied URLs to the system browser. */
export function actionsUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
/** Build a repository link for GitHub.com or an explicit enterprise host, encoding owner and repository segments. */
export function actionsRepositoryUrl(repository: GitHubRepositoryIdentity): string {
  return `https://${repository.host ?? 'github.com'}/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`
}
