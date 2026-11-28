import {
  isOfficialOrganizationGitSource,
  isSameGitRepository,
  parseGitRepositoryIdentity,
  splitQualifiedPluginKey
} from './plugin-marketplace'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from './plugin-install-link'
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

/** The plugin's folder at an exact source commit, where the host renders its
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

/** The catalog's repository claim when its namespace matches; otherwise the fetch source.
 *  Neither the claim nor a matching namespace establishes who authored the plugin. */
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

/** Orca's own reading of a Git URL: `host/owner/repo` plus the owner, never the manifest's claim. */
export function pluginRepositoryOrigin(
  url: string,
  path?: string
): { owner: string; repository: string } | null {
  const identity = parseGitRepositoryIdentity(url)
  if (!identity) {
    return null
  }
  const repository = `${identity.host}/${identity.path}`
  return { owner: identity.owner, repository: path ? `${repository} (${path})` : repository }
}

/** Who an install confirmation asks the reader to trust: the repository owner Orca parsed, else
 *  the publisher. Why the community catalog's Orca-hosted sources name the publisher: Orca mirrors
 *  community plugins there, so the owner would read stablyai; any other catalog cannot use an
 *  Orca repository to put a publisher of its choosing in the prompt. */
export function pluginInstallTrustee(source: {
  url: string
  publisher: string | null
  catalogUrl: string | null
}): string | null {
  const { url, publisher, catalogUrl } = source
  if (
    publisher &&
    catalogUrl &&
    isSameGitRepository(catalogUrl, COMMUNITY_MARKETPLACE_GIT_SOURCE.url) &&
    isOfficialOrganizationGitSource(url)
  ) {
    return publisher
  }
  return pluginRepositoryOrigin(url)?.owner ?? publisher
}
