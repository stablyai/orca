import type {
  PluginHostListEntry,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../../preload/api-types'
import { satisfiesOrcaEngineRange } from '../../../../../shared/plugins/manifest/plugin-manifest'
import {
  pluginCatalogReleaseTypes,
  type PluginCatalogType
} from '../../../../../shared/plugins/catalog/plugin-catalog-release'
import { compareAppVersions } from '../../../../../shared/app-version'
import { gitRepositoryOwnerLabel } from '../../../../../shared/plugins/catalog/plugin-marketplace'
import { pluginDisplayNameFromKey } from './plugin-display-name'
import { sanitizePluginDisplayText } from '../../../../../shared/plugins/manifest/plugin-display-text'
import type { PluginAutoUpdateState } from '../../../../../shared/plugins/catalog/plugin-update-policy'

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
  /** Catalog release to reinstall over an installed copy that can't load: same version, other bytes. */
  reinstallVersion?: string | null
  /** Every catalog that lists this plugin, for filtering by catalog. */
  catalogIds: readonly string[]
  /** The listing comes from the catalog this plugin was installed from, so it can update it. */
  updatable: boolean
  /** What automatic updates did: the version installed unasked, or an update held for review. */
  autoUpdate: PluginEntryAutoUpdate
  installed: PluginHostListEntry | null
  listing: PluginMarketplaceHostListing | null
  /** Where trust comes from: the catalog's Git address, never the manifest's text. */
  verifiedSource: PluginVerifiedSource
  /** Other catalogs listing this installed plugin; none of them can update or replace it. */
  alsoListedBy: readonly string[]
}

export type PluginVerifiedSource =
  | { kind: 'official' | 'bundled' | 'dev' | 'unverified' }
  | { kind: 'catalog'; catalog: string | null; owner: string | null }

function installedVerifiedSource(
  plugin: PluginHostListEntry,
  catalog: string | null
): PluginVerifiedSource {
  if (plugin.bundled) {
    return { kind: 'bundled' }
  }
  if (plugin.isDev) {
    return { kind: 'dev' }
  }
  if (plugin.official) {
    return { kind: 'official' }
  }
  const from = plugin.source?.marketplace
  return from
    ? { kind: 'catalog', catalog, owner: gitRepositoryOwnerLabel(from.reference) }
    : { kind: 'unverified' }
}

// Why again here: hosts sanitize these too, but the list is where every name is read.
function listingText(value: string | undefined): string | null {
  return (value && sanitizePluginDisplayText(value)) || null
}

type PluginEntryAutoUpdate = { updatedTo: string | null; needsReview: boolean }

const NO_AUTO_UPDATE: PluginEntryAutoUpdate = { updatedTo: null, needsReview: false }

function entryAutoUpdate(
  plugin: PluginHostListEntry,
  updateVersion: string | null,
  state: PluginAutoUpdateState | null
): PluginEntryAutoUpdate {
  if (!state) {
    return NO_AUTO_UPDATE
  }
  const updatedTo = state.updated[plugin.pluginKey]
  return {
    // Why version-matched: a later manual update or rollback makes the note stale.
    updatedTo: updatedTo && updatedTo === plugin.version ? updatedTo : null,
    needsReview: Boolean(updateVersion && state.needsReview[plugin.pluginKey])
  }
}

// Why: v2 catalogs flatten release fields onto the listing; the raw record covers older hosts.
function catalogVersion(listing: PluginMarketplaceHostListing): string | null {
  return listing.version ?? listing.release?.version ?? null
}

/** The minimum Orca a release needs when this Orca is older; null when it runs or either is unknown. */
export function needsNewerOrca(
  minimumOrca: string | null | undefined,
  orcaVersion: string | null
): string | null {
  return minimumOrca && orcaVersion && !satisfiesOrcaEngineRange(orcaVersion, `>=${minimumOrca}`)
    ? minimumOrca
    : null
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
  // Why: an update this Orca can't run isn't one to offer; Orca itself needs updating first.
  if (needsNewerOrca(listing?.release?.minimumOrca, orcaVersion)) {
    return null
  }
  return compareAppVersions(version, plugin.version) > 0 ? version : null
}

function reinstallCatalogVersion(
  plugin: PluginHostListEntry,
  listing: PluginMarketplaceHostListing | null,
  orcaVersion: string | null
): string | null {
  const release = listing?.release
  if (plugin.status !== 'invalid' || plugin.source?.kind !== 'marketplace' || !release) {
    return null
  }
  // Why bytes, not version: reinstalling the same bytes would fail the same way.
  return needsNewerOrca(release.minimumOrca, orcaVersion) ||
    release.contentHash === plugin.source.contentHash
    ? null
    : release.version
}

export function pluginListEntryFromInstalled(
  plugin: PluginHostListEntry,
  listing: PluginMarketplaceHostListing | null = null,
  {
    catalogIds = [],
    orcaVersion = null,
    autoUpdates = null
  }: {
    catalogIds?: readonly string[]
    orcaVersion?: string | null
    autoUpdates?: PluginAutoUpdateState | null
  } = {}
): PluginListEntry {
  const updateVersion = newerCatalogVersion(plugin, listing, orcaVersion)
  return {
    pluginKey: plugin.pluginKey,
    name: sanitizePluginDisplayText(plugin.name) || pluginDisplayNameFromKey(plugin.pluginKey),
    publisher: plugin.publisher || null,
    version: plugin.version,
    description: listingText(plugin.description ?? listing?.description),
    official: plugin.official,
    categories: listing?.categories ?? [],
    types: listing?.release ? pluginCatalogReleaseTypes(listing.release) : (plugin.types ?? []),
    minimumOrca: listing?.release?.minimumOrca ?? null,
    updateVersion,
    reinstallVersion: updateVersion ? null : reinstallCatalogVersion(plugin, listing, orcaVersion),
    catalogIds,
    updatable: plugin.source?.kind === 'marketplace' && listing !== null,
    autoUpdate: entryAutoUpdate(plugin, updateVersion, autoUpdates),
    installed: plugin,
    listing,
    verifiedSource: installedVerifiedSource(plugin, listing?.marketplaceName ?? null),
    alsoListedBy: []
  }
}

export function pluginListEntryFromListing(
  listing: PluginMarketplaceHostListing,
  catalogIds: readonly string[] = [listing.marketplaceSourceId],
  catalogUrl: string | null = null
): PluginListEntry {
  return {
    pluginKey: listing.pluginKey,
    // Why: older catalogs carry no release name; the key is the only name they have.
    name:
      listingText(listing.name ?? listing.release?.name) ??
      pluginDisplayNameFromKey(listing.pluginKey),
    publisher: listing.marketplaceOwner || null,
    version: catalogVersion(listing),
    description: listingText(listing.description),
    official: listing.official,
    categories: listing.categories,
    types: listing.release ? pluginCatalogReleaseTypes(listing.release) : [],
    minimumOrca: listing.release?.minimumOrca ?? null,
    updateVersion: null,
    catalogIds,
    updatable: false,
    autoUpdate: NO_AUTO_UPDATE,
    installed: null,
    listing,
    verifiedSource: listing.official
      ? { kind: 'official' }
      : {
          kind: 'catalog',
          catalog: listing.marketplaceName || null,
          owner: catalogUrl ? gitRepositoryOwnerLabel(catalogUrl) : null
        },
    alsoListedBy: []
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
    orcaVersion = null,
    autoUpdates = null
  }: {
    sources?: readonly PluginMarketplaceHostSourceState[]
    orcaVersion?: string | null
    autoUpdates?: PluginAutoUpdateState | null
  } = {}
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
        orcaVersion,
        autoUpdates
      })
      const own = ownCatalog && plugin.source?.marketplace ? listing : null
      entry.alsoListedBy = (listingsByKey.get(plugin.pluginKey) ?? [])
        .filter((candidate) => candidate !== own)
        .map((candidate) => candidate.marketplaceName)
      if (!own && entry.verifiedSource.kind === 'catalog') {
        // Why: another catalog's listing must never lend the install its name.
        const from = plugin.source?.marketplace?.reference
        entry.verifiedSource.catalog =
          sources.find((source) => source.source.url === from)?.marketplace?.name ?? null
      }
      return ownCatalog
        ? entry
        : {
            ...entry,
            updateVersion: null,
            reinstallVersion: null,
            updatable: false,
            autoUpdate: { ...entry.autoUpdate, needsReview: false }
          }
    }),
    available: [...listingsByKey.entries()]
      .filter(([pluginKey]) => !installedKeys.has(pluginKey))
      .map(([pluginKey, candidates]) =>
        pluginListEntryFromListing(
          candidates[0],
          catalogIdsOf(pluginKey),
          catalogById.get(candidates[0].marketplaceSourceId)?.source.url ?? null
        )
      )
  }
}

/** Search across what a user can see or would type: name, key, publisher, description, categories. */
export function matchesPluginSearch(entry: PluginListEntry, search: string): boolean {
  const query = search.trim().toLowerCase()
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
  ].some((value) => value.toLowerCase().includes(query))
}
