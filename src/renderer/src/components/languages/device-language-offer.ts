import type { PluginLanguagePackRegistration } from '../../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import {
  languageNames,
  recommendedLanguagePack,
  type CatalogLanguagePack
} from './language-pack-options'

/** A community translation matching a device language Orca has no built-in translation for. */
export type DeviceLanguageOffer = {
  locale: string
  /** Native name, e.g. "italiano"; render it with `lang={locale}`. */
  name: string
  /** English name, e.g. "Italian". */
  englishName: string
  /** Set when the matching pack is already installed and usable: offer to switch, not install. */
  installed: PluginLanguagePackRegistration | null
  catalog: CatalogLanguagePack | null
}

/** What a surface needs to name an offer and its action. */
export type LanguageOfferSummary = {
  locale: string
  /** Native name, for the action that switches to it. */
  name: string
  /** English name, for the English sentence around it. */
  englishName: string
  installed: boolean
}

export function offerSummary(offer: DeviceLanguageOffer): LanguageOfferSummary {
  return {
    locale: offer.locale,
    name: offer.name,
    englishName: offer.englishName,
    installed: offer.installed !== null
  }
}

/** Prefers an installed match so the offer never asks to install what is already there. */
export function deviceLanguageOffer(
  installed: readonly PluginLanguagePackRegistration[],
  catalogPacks: readonly CatalogLanguagePack[],
  detectedTag: string | null
): DeviceLanguageOffer | null {
  const installedMatch = recommendedLanguagePack(installed, detectedTag) ?? null
  const catalogMatch = installedMatch
    ? null
    : (recommendedLanguagePack(catalogPacks, detectedTag) ?? null)
  const locale = installedMatch?.locale ?? catalogMatch?.locale
  if (!locale) {
    return null
  }
  const names = languageNames(locale)
  return {
    locale,
    name: names.native,
    englishName: names.english,
    installed: installedMatch,
    catalog: catalogMatch
  }
}

/** The same shape for a pack the user picked from a list, so it installs and reports alike. */
export function catalogPackOffer(pack: CatalogLanguagePack): DeviceLanguageOffer {
  const names = languageNames(pack.locale)
  return {
    locale: pack.locale,
    name: names.native,
    englishName: names.english,
    installed: null,
    catalog: pack
  }
}
