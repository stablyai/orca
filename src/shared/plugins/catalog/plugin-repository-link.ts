import { parseGitRepositoryIdentity } from './plugin-marketplace'

const LINKABLE_GIT_HOSTS = new Set(['github.com', 'gitlab.com'])
const PATH_SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/** The web page of the git repository Orca installs a plugin from, built by Orca itself; null
 *  unless it is on github.com or gitlab.com. Why: plugin- and catalog-supplied URLs are never
 *  opened, so a listing cannot turn its page into a link to anywhere. */
export function pluginRepositoryPageUrl(gitUrl: string): string | null {
  const identity = parseGitRepositoryIdentity(gitUrl)
  if (!identity || !LINKABLE_GIT_HOSTS.has(identity.host)) {
    return null
  }
  const segments = identity.path.split('/')
  if (!segments.every((segment) => PATH_SEGMENT_RE.test(segment))) {
    return null
  }
  return `https://${identity.host}/${segments.join('/')}`
}
