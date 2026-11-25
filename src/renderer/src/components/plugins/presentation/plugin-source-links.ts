import type { PluginListEntry } from '../list/plugin-list-entries'
import {
  pluginListingRepositoryUrl,
  pluginRepositoryPageUrl,
  pluginReadmePageUrl
} from '../../../../../shared/plugins/catalog/plugin-repository-link'
import {
  isSamePluginSource,
  pluginSourceLabel
} from '../../../../../shared/plugins/catalog/plugin-marketplace'
import { gitUrlPluginPublisher } from '../../../../../shared/plugins/installation/plugin-publisher-derivation'

function installedGitLocation(entry: PluginListEntry): { url: string; path?: string } | null {
  const source = entry.installed?.source
  if (entry.installed?.isDev || !source) {
    return null
  }
  if (source.kind === 'git') {
    return { url: source.url ?? source.reference, path: source.path }
  }
  if (source.kind !== 'marketplace') {
    return null
  }
  if (source.url) {
    return { url: source.url, path: source.path }
  }
  const listing = entry.listing
  // Older hosts expose only this display label; compare the whole location without parsing it.
  return source.marketplace &&
    entry.updatable &&
    listing?.pluginKey === entry.pluginKey &&
    source.reference === pluginSourceLabel(listing.source)
    ? listing.source
    : null
}

function installedCatalogRepository(entry: PluginListEntry): string | undefined {
  const source = entry.installed?.source
  const location = installedGitLocation(entry)
  const listing = entry.listing
  const release = listing?.release
  const matchingRelease =
    source?.marketplace &&
    entry.updatable &&
    location &&
    listing?.pluginKey === entry.pluginKey &&
    release &&
    isSamePluginSource(location, listing.source) &&
    source.resolvedCommit === release.commit &&
    source.contentHash === release.contentHash
      ? release
      : undefined
  return matchingRelease?.sourceUnavailable
    ? undefined
    : source?.authorRepository || matchingRelease?.repository
}

/** Repository claims are catalog metadata, not evidence of authorship. */
export function pluginSourceGitUrl(entry: PluginListEntry): string | null {
  if (!entry.installed) {
    return entry.listing ? pluginListingRepositoryUrl(entry.listing) : null
  }
  const location = installedGitLocation(entry)
  if (!location) {
    return null
  }
  return entry.installed.source?.kind === 'git'
    ? location.url
    : pluginListingRepositoryUrl({
        pluginKey: entry.pluginKey,
        source: location,
        release: { repository: installedCatalogRepository(entry) }
      })
}

export function pluginAuthorGithubUrl(entry: PluginListEntry): string | null {
  const repository = pluginSourceGitUrl(entry)
  if (!repository || gitUrlPluginPublisher(repository) !== entry.publisher) {
    return null
  }
  const page = pluginRepositoryPageUrl(repository)
  if (!page) {
    return null
  }
  const url = new URL(page)
  return url.hostname === 'github.com' ? `https://github.com/${url.pathname.split('/')[1]}` : null
}

/** README links use the fetched repository and commit, including a mirror's own directory. */
export function pluginSourceReadmeUrl(entry: PluginListEntry): string | null {
  const location = entry.installed ? installedGitLocation(entry) : entry.listing?.source
  const commit =
    entry.installed?.source?.resolvedCommit ??
    (!entry.installed ? entry.listing?.release?.commit : null)
  return location && commit
    ? pluginReadmePageUrl({ gitUrl: location.url, path: location.path, commit })
    : null
}
