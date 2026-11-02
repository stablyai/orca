import type {
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import {
  isOfficialMarketplaceGitSource,
  isSameGitRepository
} from '../../../../../shared/plugins/catalog/plugin-marketplace'
import { COMMUNITY_MARKETPLACE_GIT_SOURCE } from '../../../../../shared/plugins/catalog/plugin-install-link'

/** The listing comes from Orca's official or community catalog, whose plugins have public stats. */
export function isPublicCatalogListing(
  listing: PluginMarketplaceHostListing | null,
  catalogById: ReadonlyMap<string, PluginMarketplaceHostSourceState>
): boolean {
  if (!listing) {
    return false
  }
  const url = catalogById.get(listing.marketplaceSourceId)?.source.url
  return Boolean(
    url &&
    (isOfficialMarketplaceGitSource(url) ||
      isSameGitRepository(url, COMMUNITY_MARKETPLACE_GIT_SOURCE.url))
  )
}
