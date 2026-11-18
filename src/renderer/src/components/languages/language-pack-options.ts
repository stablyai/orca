import type {
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from '../../../../preload/api/plugins/plugin-host-api'
import type { PluginLanguagePackRegistration } from '../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { normalizeUiLocaleTag } from '../../../../shared/i18n/ui-locale'
import { languageDisplayName } from '@/i18n/ui-intl-formatters'
import type { PluginUiLanguage } from '../../../../shared/i18n/ui-language'
import { isPublicCatalogListing } from '../plugins/list/plugin-public-catalog'

export type CatalogLanguagePack = {
  id: PluginUiLanguage
  locale: string
  listing: PluginMarketplaceHostListing
  /** Listed by Orca's official or community catalog, whose plugins have public stats. */
  publicCatalog?: boolean
}

function releaseTimestamp(listing: PluginMarketplaceHostListing): number {
  const raw = listing.updatedAt ?? listing.release?.updatedAt
  const parsed = raw ? Date.parse(raw) : Number.NaN
  return Number.isNaN(parsed) ? -Infinity : parsed
}

export function sortCatalogLanguagePacks(
  packs: readonly CatalogLanguagePack[],
  installCounts: Readonly<Record<string, number>> = {}
): CatalogLanguagePack[] {
  const countOf = (pack: CatalogLanguagePack): number =>
    pack.publicCatalog && typeof installCounts[pack.listing.pluginKey] === 'number'
      ? installCounts[pack.listing.pluginKey]
      : -1
  return [...packs].sort(
    (a, b) => countOf(b) - countOf(a) || releaseTimestamp(b.listing) - releaseTimestamp(a.listing)
  )
}

export function catalogLanguagePacks(
  listings: readonly PluginMarketplaceHostListing[],
  catalogById?: ReadonlyMap<string, PluginMarketplaceHostSourceState>,
  installCounts: Readonly<Record<string, number>> = {}
): CatalogLanguagePack[] {
  const packs = listings.flatMap((listing) => {
    if (listing.blockedByKillList || listing.release?.execution !== 'data') {
      return []
    }
    const publicCatalog = catalogById ? isPublicCatalogListing(listing, catalogById) : false
    return (listing.release.contributes ?? []).flatMap((item) => {
      const locale = item.kind === 'languagePacks' ? normalizeUiLocaleTag(item.name) : null
      return locale
        ? [
            {
              id: `plugin:${listing.pluginKey}/${item.name}`,
              locale,
              listing,
              publicCatalog
            } satisfies CatalogLanguagePack
          ]
        : []
    })
  })
  return sortCatalogLanguagePacks(packs, installCounts)
}

export function packInstallCount(
  pack: CatalogLanguagePack | PluginLanguagePackRegistration,
  catalogPacks: readonly CatalogLanguagePack[],
  installCounts: Readonly<Record<string, number>>
): number | undefined {
  const pluginKey = 'listing' in pack ? pack.listing.pluginKey : pack.pluginKey
  const eligible =
    'listing' in pack
      ? pack.publicCatalog === true
      : catalogPacks.some(
          (candidate) => candidate.listing.pluginKey === pluginKey && candidate.publicCatalog
        )
  const count = eligible ? installCounts[pluginKey] : undefined
  return typeof count === 'number' ? count : undefined
}

export function languageNames(locale: string): { native: string; english: string } {
  return { native: languageDisplayName(locale, locale), english: languageDisplayName(locale, 'en') }
}

export function languageMatchesDevice(locale: string, detectedTag: string | null): boolean {
  const candidate = normalizeUiLocaleTag(locale)
  const detected = normalizeUiLocaleTag(detectedTag ?? undefined)
  if (!candidate || !detected) {
    return false
  }
  const a = new Intl.Locale(candidate).maximize()
  const b = new Intl.Locale(detected).maximize()
  return a.language === b.language && a.script === b.script
}

export function recommendedLanguagePack<T extends { locale: string }>(
  packs: readonly T[],
  detectedTag: string | null
): T | undefined {
  const detected = normalizeUiLocaleTag(detectedTag ?? undefined)
  return (
    packs.find((pack) => detected !== null && normalizeUiLocaleTag(pack.locale) === detected) ??
    packs.find((pack) => languageMatchesDevice(pack.locale, detected))
  )
}

export function packPublisher(pack: CatalogLanguagePack | PluginLanguagePackRegistration): string {
  return ('listing' in pack ? pack.listing.pluginKey : pack.pluginKey).split('.')[0]
}

/** Catalog packs that aren't installed yet, each listed once. */
export function availableCatalogPacks(
  installed: readonly { id: string }[],
  catalog: readonly CatalogLanguagePack[]
): CatalogLanguagePack[] {
  const installedIds = new Set(installed.map((pack) => pack.id))
  return catalog.filter(
    (pack, index, packs) =>
      !installedIds.has(pack.id) && packs.findIndex((other) => other.id === pack.id) === index
  )
}

/** Native names shared by more than one pack; only those need the publisher to tell them apart. */
export function sharedLanguageNames(packs: readonly { locale: string }[]): Set<string> {
  const counts = new Map<string, number>()
  for (const pack of packs) {
    const name = languageNames(pack.locale).native
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
}
