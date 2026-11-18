import type {
  PluginHostInstallSource,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api/plugins/plugin-host-api'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import { isQualifiedPluginKey } from '../../../../../shared/plugins/frames/plugin-tab-key'
import {
  isSameGitRepository,
  splitQualifiedPluginKey
} from '../../../../../shared/plugins/catalog/plugin-marketplace'
import {
  pluginListingRepositoryUrl,
  pluginRepositoryOrigin,
  pluginRepositoryPageUrl
} from '../../../../../shared/plugins/catalog/plugin-repository-link'
import { gitUrlPluginPublisher } from '../../../../../shared/plugins/installation/plugin-publisher-derivation'
import { sanitizePluginDisplayText } from '../../../../../shared/plugins/manifest/plugin-display-text'
import { publicPluginCatalogKind, publicPluginPageUrl } from '../list/plugin-public-catalog'
import { pluginPointsFromManifest, pluginTrust } from './plugin-access-profile'
import { pluginTrustWarnings } from './plugin-consent-copy'
import { pluginPublisherNotice } from './plugin-publisher-trust'

const COMMUNITY_MIRROR_GIT_URL = 'https://github.com/stablyai/orca-community-mirror.git'

/** Which warning the install confirmation gives; content kinds get the softer copy. */
export type PluginInstallTrustKind =
  | 'theme'
  | 'content'
  | 'translations'
  | 'code'
  | 'git'
  | 'local-folder'
  | 'dev-folder'

export type PluginInstallTrustPrompt = {
  kind: PluginInstallTrustKind
  /** Who the reader must trust: the repository owner Orca parsed, else the derived publisher. */
  trustee: string
  /** The publisher Orca derives from where it installs from, never the manifest's claim. */
  publisher: string | null
  /** Release version being installed, e.g. "1.4.261". */
  version?: string | null
  /** ISO 8601 release date from the catalog listing. */
  updatedAt?: string | null
  /** Public catalog plugin key whose install count may show. */
  installCountPluginKey?: string | null
  /** `host/owner/repo`, parsed by Orca from the URL it installs from. */
  repository: string | null
  /** Safe GitHub/GitLab URL built by Orca, never raw plugin text. */
  repositoryUrl?: string | null
  /** Directory page on orca.dev when listed in Orca's official or community catalog. */
  pluginPageUrl?: string | null
  /** A catalog's name, or a local folder's path. */
  location: string | null
  /** What a code plugin may do once enabled; empty for content. */
  access: string[]
}

export { pluginRepositoryOrigin }

const THEME_POINTS = ['themes', 'iconThemes', 'terminalThemes'] as const

/**
 * The confirmation a catalog install needs, or null for an official plugin. Every other plugin
 * asks, content included, because only Orca's own catalog vouches for its author.
 */
export function catalogInstallTrustPrompt(
  listing: PluginMarketplaceHostListing,
  preview: PluginMarketplaceHostInstallPreview,
  catalogUrl?: string | null
): PluginInstallTrustPrompt | null {
  // Why both: main derives each from the catalog it read; either saying no is enough to ask.
  if (listing.official && preview.official) {
    return null
  }
  const { manifest } = preview
  const execution = listing.release?.execution ?? pluginExecutionProfile(manifest)
  const notice = pluginPublisherNotice({ official: false, execution, manifest, types: null })
  const publicCatalog = publicPluginCatalogKind(catalogUrl)
  // Why the listing id: catalog installs are keyed by it, so it is the publisher Orca installs as.
  const publisher = splitQualifiedPluginKey(listing.pluginKey)?.publisher ?? null
  // Why only the community catalog unwinds its mirror: a third-party catalog cannot claim another repo.
  const sourceUrl =
    publicCatalog === 'community' ? pluginListingRepositoryUrl(listing) : listing.source.url
  const mirrored =
    publicCatalog === 'community' && isSameGitRepository(sourceUrl, COMMUNITY_MIRROR_GIT_URL)
  const origin = pluginRepositoryOrigin(
    sourceUrl,
    sourceUrl === listing.source.url ? listing.source.path : undefined
  )
  const themed = THEME_POINTS.some((point) => manifest.contributes[point].length > 0)
  const kind: PluginInstallTrustKind =
    notice === 'code'
      ? 'code'
      : notice === 'translations'
        ? 'translations'
        : themed
          ? 'theme'
          : 'content'
  const version =
    sanitizePluginDisplayText(
      manifest.version || listing.version || listing.release?.version || ''
    ) || null
  return {
    kind,
    trustee: (mirrored ? publisher : origin?.owner) ?? publisher ?? listing.pluginKey,
    publisher,
    version,
    updatedAt: listing.updatedAt ?? listing.release?.updatedAt ?? null,
    installCountPluginKey: publicCatalog ? listing.pluginKey : null,
    repository: origin?.repository ?? sourceUrl,
    repositoryUrl: mirrored ? null : pluginRepositoryPageUrl(sourceUrl),
    pluginPageUrl:
      publicCatalog && isQualifiedPluginKey(listing.pluginKey)
        ? publicPluginPageUrl(listing.pluginKey, publicCatalog)
        : null,
    location: listing.marketplaceName || null,
    access:
      kind === 'code'
        ? pluginTrustWarnings(
            pluginTrust({ execution, points: pluginPointsFromManifest(manifest) })
          )
        : []
  }
}

/** A Git URL or folder install: nothing is verified before it lands, so it warns as code. */
export function sourceInstallTrustPrompt(
  source: PluginHostInstallSource
): PluginInstallTrustPrompt {
  if (source.kind === 'local-path') {
    return localFolderTrustPrompt('local-folder', source.path)
  }
  const origin = pluginRepositoryOrigin(source.url)
  return {
    kind: 'git',
    trustee: origin?.owner ?? source.url,
    publisher: gitUrlPluginPublisher(source.url),
    repository: origin?.repository ?? source.url,
    repositoryUrl: pluginRepositoryPageUrl(source.url),
    location: null,
    access: []
  }
}

export function localFolderTrustPrompt(
  kind: 'local-folder' | 'dev-folder',
  path: string
): PluginInstallTrustPrompt {
  return { kind, trustee: path, publisher: null, repository: null, location: path, access: [] }
}
