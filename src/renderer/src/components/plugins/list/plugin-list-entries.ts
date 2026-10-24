import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import { satisfiesOrcaEngineRange } from '../../../../../shared/plugins/manifest/plugin-manifest'
import type { PluginCatalogType } from '../../../../../shared/plugins/catalog/plugin-catalog-release'
import { compareAppVersions } from '../../../../../shared/app-version'
import { pluginDisplayNameFromKey } from './plugin-display-name'

/** One plugin as the list and detail page show it, whether installed, listed, or both. */
export type PluginListEntry = {
  pluginKey: string
  name: string
  publisher: string | null
  version: string | null
  description: string | null
  official: boolean
  categories: readonly string[]
  /** What the catalog says this release contributes; empty when unknown. */
  types: readonly PluginCatalogType[]
  /** Oldest Orca the catalog release supports, e.g. "1.6.0". */
  minimumOrca: string | null
  /** A newer catalog version than the installed one that this Orca can run, if any. */
  updateVersion: string | null
  /** Every catalog that lists this plugin, for filtering by catalog. */
  catalogIds: readonly string[]
  /** The listing comes from the catalog this plugin was installed from, so it can update it. */
  updatable: boolean
  installed: PluginHostListEntry | null
  listing: PluginMarketplaceHostListing | null
}

// Why: v2 catalogs flatten release fields onto the listing; the raw record covers older hosts.
function catalogVersion(listing: PluginMarketplaceHostListing): string | null {
  return listing.version ?? listing.release?.version ?? null
}

function newerCatalogVersion(
  plugin: PluginHostListEntry,
  listing: PluginMarketplaceHostListing | null,
  orcaVersion: string | null
): string | null {
  const version = listing ? catalogVersion(listing) : null
  if (!version || plugin.source?.kind !== 'marketplace') {
    return null
  }
  const minimumOrca = listing?.release?.minimumOrca
  // Why: an update this Orca can't run isn't one to offer; Orca itself needs updating first.
  if (minimumOrca && orcaVersion && !satisfiesOrcaEngineRange(orcaVersion, `>=${minimumOrca}`)) {
    return null
  }
  return compareAppVersions(version, plugin.version) > 0 ? version : null
}

export function pluginListEntryFromInstalled(
  plugin: PluginHostListEntry,
  listing: PluginMarketplaceHostListing | null = null,
  {
    catalogIds = [],
    orcaVersion = null
  }: { catalogIds?: readonly string[]; orcaVersion?: string | null } = {}
): PluginListEntry {
  return {
    pluginKey: plugin.pluginKey,
    name: plugin.name,
    publisher: plugin.publisher || null,
    version: plugin.version,
    description: plugin.description ?? listing?.description ?? null,
    official: plugin.official,
    categories: listing?.categories ?? [],
    types: listing?.release?.types ?? [],
    minimumOrca: listing?.release?.minimumOrca ?? null,
    updateVersion: newerCatalogVersion(plugin, listing, orcaVersion),
    catalogIds,
    updatable: plugin.source?.kind === 'marketplace' && listing !== null,
    installed: plugin,
    listing
  }
}

export function pluginListEntryFromListing(
  listing: PluginMarketplaceHostListing,
  catalogIds: readonly string[] = [listing.marketplaceSourceId]
): PluginListEntry {
  return {
    pluginKey: listing.pluginKey,
    // Why: older catalogs carry no release name; the key is the only name they have.
    name: listing.name ?? listing.release?.name ?? pluginDisplayNameFromKey(listing.pluginKey),
    publisher: listing.marketplaceOwner || null,
    version: catalogVersion(listing),
    description: listing.description ?? null,
    official: listing.official,
    categories: listing.categories,
    types: listing.release?.types ?? [],
    minimumOrca: listing.release?.minimumOrca ?? null,
    updateVersion: null,
    catalogIds,
    updatable: false,
    installed: null,
    listing
  }
}

/**
 * The listing from the catalog a plugin was installed from, else the first that lists it. Only a
 * listing from the plugin's own catalog may offer an update; another catalog's is display-only.
 */
function sourceListing(
  plugin: PluginHostListEntry,
  candidates: readonly PluginMarketplaceHostListing[],
  catalogById: ReadonlyMap<string, PluginMarketplaceHostSourceState>
): { listing: PluginMarketplaceHostListing | null; ownCatalog: boolean } {
  const installedFrom = plugin.source?.marketplace
  // Why url+ref: that is how the host finds the catalog an update comes from; older hosts send no ref.
  const own = installedFrom
    ? candidates.find((listing) => {
        const catalog = catalogById.get(listing.marketplaceSourceId)
        return (
          catalog?.source.url === installedFrom.reference &&
          (installedFrom.ref === undefined || catalog.source.ref === installedFrom.ref)
        )
      })
    : undefined
  if (own) {
    return { listing: own, ownCatalog: true }
  }
  // Why: with no recorded catalog (older installs) the first listing is the best guess.
  return { listing: candidates[0] ?? null, ownCatalog: !installedFrom }
}

/**
 * Installed plugins first, each joined to the catalog it came from, then catalog plugins not
 * installed. A plugin listed by two catalogs shows once, under the first.
 */
export function buildPluginListEntries(
  installed: readonly PluginHostListEntry[],
  listings: readonly PluginMarketplaceHostListing[],
  {
    sources = [],
    orcaVersion = null
  }: { sources?: readonly PluginMarketplaceHostSourceState[]; orcaVersion?: string | null } = {}
): { installed: PluginListEntry[]; available: PluginListEntry[] } {
  const listingsByKey = new Map<string, PluginMarketplaceHostListing[]>()
  for (const listing of listings) {
    listingsByKey.set(listing.pluginKey, [...(listingsByKey.get(listing.pluginKey) ?? []), listing])
  }
  const catalogById = new Map(sources.map((source) => [source.id, source]))
  const catalogIdsOf = (pluginKey: string): string[] =>
    (listingsByKey.get(pluginKey) ?? []).map((listing) => listing.marketplaceSourceId)
  const installedKeys = new Set(installed.map((plugin) => plugin.pluginKey))
  return {
    installed: installed.map((plugin) => {
      const { listing, ownCatalog } = sourceListing(
        plugin,
        listingsByKey.get(plugin.pluginKey) ?? [],
        catalogById
      )
      const entry = pluginListEntryFromInstalled(plugin, listing, {
        catalogIds: catalogIdsOf(plugin.pluginKey),
        orcaVersion
      })
      return ownCatalog ? entry : { ...entry, updateVersion: null, updatable: false }
    }),
    available: [...listingsByKey.entries()]
      .filter(([pluginKey]) => !installedKeys.has(pluginKey))
      .map(([pluginKey, candidates]) =>
        pluginListEntryFromListing(candidates[0], catalogIdsOf(pluginKey))
      )
  }
}

/** Search across what a user can see or would type: name, key, publisher, description, categories. */
export function matchesPluginSearch(entry: PluginListEntry, search: string): boolean {
  const query = search.trim().toLocaleLowerCase()
  if (!query) {
    return true
  }
  return [
    entry.name,
    entry.pluginKey,
    entry.publisher ?? '',
    entry.description ?? '',
    entry.listing?.marketplaceName ?? '',
    ...entry.categories
  ].some((value) => value.toLocaleLowerCase().includes(query))
}
