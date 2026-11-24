import type { PluginMarketplaceHostListing } from '../../../../preload/api/plugins/plugin-host-api'
import type { PluginLanguagePackRegistration } from '../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { normalizeUiLocaleTag } from '../../../../shared/i18n/ui-locale'
import { languageDisplayName } from '@/i18n/ui-intl-formatters'
import type { PluginUiLanguage } from '../../../../shared/i18n/ui-language'

export type CatalogLanguagePack = {
  id: PluginUiLanguage
  locale: string
  listing: PluginMarketplaceHostListing
}

export function catalogLanguagePacks(
  listings: readonly PluginMarketplaceHostListing[]
): CatalogLanguagePack[] {
  return listings.flatMap((listing) => {
    if (listing.blockedByKillList || listing.release?.execution !== 'data') {
      return []
    }
    return (listing.release.contributes ?? []).flatMap((item) => {
      const locale = item.kind === 'languagePacks' ? normalizeUiLocaleTag(item.name) : null
      return locale
        ? [
            {
              id: `plugin:${listing.pluginKey}/${item.name}`,
              locale,
              listing
            } satisfies CatalogLanguagePack
          ]
        : []
    })
  })
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
