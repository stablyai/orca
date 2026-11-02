import type {
  PluginHostInstallSource,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing
} from '../../../../../preload/api-types'
import { pluginExecutionProfile } from '../../../../../shared/plugins/contributions/plugin-execution-profile'
import {
  parseGitRepositoryIdentity,
  splitQualifiedPluginKey
} from '../../../../../shared/plugins/catalog/plugin-marketplace'
import { gitUrlPluginPublisher } from '../../../../../shared/plugins/installation/plugin-publisher-derivation'
import { pluginPointsFromManifest, pluginTrust } from './plugin-access-profile'
import { pluginTrustWarnings } from './plugin-consent-copy'
import { pluginPublisherNotice } from './plugin-publisher-trust'

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
  /** `host/owner/repo`, parsed by Orca from the URL it installs from. */
  repository: string | null
  /** A catalog's name, or a local folder's path. */
  location: string | null
  /** What a code plugin may do once enabled; empty for content. */
  access: string[]
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

const THEME_POINTS = ['themes', 'iconThemes', 'terminalThemes'] as const

/**
 * The confirmation a catalog install needs, or null for an official plugin. Every other plugin
 * asks, content included, because only Orca's own catalog vouches for its author.
 */
export function catalogInstallTrustPrompt(
  listing: PluginMarketplaceHostListing,
  preview: PluginMarketplaceHostInstallPreview
): PluginInstallTrustPrompt | null {
  // Why both: main derives each from the catalog it read; either saying no is enough to ask.
  if (listing.official && preview.official) {
    return null
  }
  const { manifest } = preview
  const execution = listing.release?.execution ?? pluginExecutionProfile(manifest)
  const notice = pluginPublisherNotice({ official: false, execution, manifest, types: null })
  const origin = pluginRepositoryOrigin(listing.source.url, listing.source.path)
  // Why the listing id: catalog installs are keyed by it, so it is the publisher Orca installs as.
  const publisher = splitQualifiedPluginKey(listing.pluginKey)?.publisher ?? null
  const themed = THEME_POINTS.some((point) => manifest.contributes[point].length > 0)
  const kind: PluginInstallTrustKind =
    notice === 'code'
      ? 'code'
      : notice === 'translations'
        ? 'translations'
        : themed
          ? 'theme'
          : 'content'
  return {
    kind,
    trustee: origin?.owner ?? publisher ?? listing.pluginKey,
    publisher,
    repository: origin?.repository ?? listing.source.url,
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
