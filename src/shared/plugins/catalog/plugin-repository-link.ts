import { parseGitRepositoryIdentity, splitQualifiedPluginKey } from './plugin-marketplace'
import { gitUrlPluginPublisher } from '../installation/plugin-publisher-derivation'

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

const COMMIT_RE = /^[0-9a-f]{40}$/

/** The plugin's folder at the exact commit the catalog pinned, where the host renders its
 *  README; built like `pluginRepositoryPageUrl`, so a listing cannot point it elsewhere. */
export function pluginReadmePageUrl(source: {
  gitUrl: string
  commit: string
  path?: string
}): string | null {
  const repository = pluginRepositoryPageUrl(source.gitUrl)
  if (!repository || !COMMIT_RE.test(source.commit)) {
    return null
  }
  const pathSegments = source.path ? source.path.split('/') : []
  if (!pathSegments.every((segment) => PATH_SEGMENT_RE.test(segment))) {
    return null
  }
  const tree = repository.startsWith('https://gitlab.com/') ? '-/tree' : 'tree'
  return `${[repository, tree, source.commit, ...pathSegments].join('/')}#readme`
}

/** The repository a listing's links open: the release's recorded author repository when it
 *  belongs to the listed publisher, else the install source (such as Stably's mirror, which a
 *  catalog marks `sourceUnavailable` once the author's repository is gone). */
export function pluginListingRepositoryUrl(listing: {
  pluginKey: string
  source: { url: string }
  release?: { repository?: string; sourceUnavailable?: true }
}): string {
  const authored = listing.release?.repository
  if (
    authored &&
    !listing.release?.sourceUnavailable &&
    pluginRepositoryPageUrl(authored) &&
    gitUrlPluginPublisher(authored) === splitQualifiedPluginKey(listing.pluginKey)?.publisher
  ) {
    return authored
  }
  return listing.source.url
}
