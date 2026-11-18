import type {
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api/plugins/plugin-host-api'
import {
  isOfficialMarketplaceGitSource,
  isSameGitRepository
} from '../../../../../shared/plugins/catalog/plugin-marketplace'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../../../shared/plugins/catalog/plugin-install-link'

export type PublicPluginCatalogKind = 'official' | 'community'

/** The public catalog a marketplace URL names, or null for any other catalog. */
export function publicPluginCatalogKind(
  url: string | null | undefined
): PublicPluginCatalogKind | null {
  if (!url) {
    return null
  }
  if (isOfficialMarketplaceGitSource(url)) {
    return 'official'
  }
  return isSameGitRepository(url, COMMUNITY_MARKETPLACE_GIT_SOURCE.url) ? 'community' : null
}

/** Web directory page on orca.dev for a plugin in Orca's official or community catalog. */
export function publicPluginPageUrl(pluginKey: string, catalog: PublicPluginCatalogKind): string {
  const path = `https://orca.dev/plugins/${encodeURIComponent(pluginKey)}`
  return catalog === 'community' ? `${path}?catalog=community` : path
}

/** The listing comes from Orca's official or community catalog, whose plugins have public stats. */
export function isPublicCatalogListing(
  listing: PluginMarketplaceHostListing | null,
  catalogById: ReadonlyMap<string, PluginMarketplaceHostSourceState>
): boolean {
  return Boolean(
    listing && publicPluginCatalogKind(catalogById.get(listing.marketplaceSourceId)?.source.url)
  )
}
