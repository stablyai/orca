import type { Repo } from '../../../shared/repo-types'

/**
 * The name a repository goes by on its remote, e.g. `owner/repo`. A project's
 * display name need not match it, so search and labels read it from here.
 */
export function getRemoteRepositoryName(
  repo: Pick<Repo, 'gitRemoteIdentity'> | null | undefined
): string {
  // Why not splitGitRemoteKey: it lower-cases, and this text is shown and split into words by case.
  const key = repo?.gitRemoteIdentity?.canonicalKey.trim().replace(/\/+$/, '') ?? ''
  const hostEnd = key.indexOf('/')
  return hostEnd > 0 && hostEnd < key.length - 1 ? key.slice(hostEnd + 1) : ''
}
