import type { TOptions } from 'i18next'
import { initReactI18next } from 'react-i18next'

import enRuntimeRequired from './en-runtime-required.json'
import deCatalogUrl from './locales/de.json?url'
import esCatalogUrl from './locales/es.json?url'
import frCatalogUrl from './locales/fr.json?url'
import jaCatalogUrl from './locales/ja.json?url'
import koCatalogUrl from './locales/ko.json?url'
import ptCatalogUrl from './locales/pt.json?url'
import ruCatalogUrl from './locales/ru.json?url'
import trCatalogUrl from './locales/tr.json?url'
import zhCatalogUrl from './locales/zh.json?url'
import zhHantCatalogUrl from './locales/zh-Hant.json?url'
import {
  advanceTranslationResourceVersion,
  getTranslationResourceVersion
} from './translation-resource-version'
import { resolveUiLocale } from './supported-languages'
import type { SupportedUiLocale } from '../../../shared/ui-locale'
import type { UiLanguage } from '../../../shared/ui-language'
import type { PluginLanguagePackRegistration } from '../../../shared/plugins/artifacts/plugin-language-pack-artifact'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import { supportedIntlLocale } from './intl-locale-support'
import { createOrcaI18n } from '../../../shared/orca-i18n-instance'

// Fetch catalogs as data: Chromium caches rejected module imports for the document's lifetime.
const NON_DEFAULT_LOCALE_URLS: Record<Exclude<SupportedUiLocale, 'en'>, string> = {
  de: deCatalogUrl,
  es: esCatalogUrl,
  fr: frCatalogUrl,
  ja: jaCatalogUrl,
  ko: koCatalogUrl,
  pt: ptCatalogUrl,
  ru: ruCatalogUrl,
  tr: trCatalogUrl,
  zh: zhCatalogUrl,
  'zh-Hant': zhHantCatalogUrl
}

const LOCALE_CATALOG_URLS = new Map<string, string>(Object.entries(NON_DEFAULT_LOCALE_URLS))

// Built-in catalogs ship every CLDR plural form (sync:localization-catalog), so they load as-is.
async function fetchLocaleCatalog(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`Language catalog request failed: ${response.status}`)
  }
  return response.json()
}

// The provider, onboarding switcher and backend can ask for one locale at once; share the fetch.
const catalogRequests = new Map<string, Promise<Record<string, unknown>>>()

/** Undefined for English and unknown locales, which need no catalog load. */
function loadLocaleCatalog(language: string): Promise<Record<string, unknown>> | undefined {
  const pending = catalogRequests.get(language)
  const url = LOCALE_CATALOG_URLS.get(language)
  if (pending || !url) {
    return pending
  }
  const request = fetchLocaleCatalog(url).finally(() => {
    if (catalogRequests.get(language) === request) {
      catalogRequests.delete(language)
    }
  })
  catalogRequests.set(language, request)
  return request
}

const orcaI18n = createOrcaI18n({
  loadCatalog: loadLocaleCatalog,
  // Inline defaults cover most English; sync:localization-runtime-catalog retains plural/dynamic/edited entries. en.json remains the translator source for lazy catalogs.
  englishResources: enRuntimeRequired,
  modules: [initReactI18next],
  initOptions: { react: { useSuspense: false } }
})

export const i18n = orcaI18n.i18n

// Plugin packs can replace translations without changing the active language.
i18n.store.on('added', advanceTranslationResourceVersion)
i18n.store.on('removed', advanceTranslationResourceVersion)
i18n.on('languageChanged', advanceTranslationResourceVersion)

// Re-rendered chrome resolves hundreds of option-free strings per workspace switch; they only change with language or resources.
const PLAIN_TRANSLATION_CACHE_LIMIT = 5000
const plainTranslationCache = new Map<string, string>()
let plainTranslationCacheScope = ''

export function translate(key: string, fallback: string, options?: TOptions): string {
  if (options !== undefined) {
    return orcaI18n.translate(key, fallback, options)
  }
  const scope = `${i18n.isInitialized}\0${i18n.language}\0${getTranslationResourceVersion()}`
  if (
    scope !== plainTranslationCacheScope ||
    plainTranslationCache.size >= PLAIN_TRANSLATION_CACHE_LIMIT
  ) {
    plainTranslationCache.clear()
    plainTranslationCacheScope = scope
  }
  const cacheKey = `${key}\0${fallback}`
  const cached = plainTranslationCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const value = orcaI18n.translate(key, fallback)
  plainTranslationCache.set(cacheKey, value)
  return value
}

export async function loadRendererUiLanguage(language: UiLanguage): Promise<string> {
  const locale = orcaI18n.resolveResourceLanguage(resolveUiLocale(language))
  const request = i18n.hasResourceBundle(locale, 'translation')
    ? undefined
    : loadLocaleCatalog(locale)
  if (request) {
    const catalog = await withTimeout(request, 5000, null)
    if (catalog === null) {
      // A retry after a timeout must start a fresh request instead of joining the stalled one.
      if (catalogRequests.get(locale) === request) {
        catalogRequests.delete(locale)
      }
      throw new Error('Language catalog unavailable')
    }
    if (!i18n.hasResourceBundle(locale, 'translation')) {
      // Freshly parsed and never mutated, so skip i18next's defensive deep copy.
      i18n.addResourceBundle(locale, 'translation', catalog, false, false, { skipCopy: true })
    }
  }
  return locale
}

/** Resolve an Intl-compatible BCP-47 tag: plugin pack resources use the pack’s declared tag, then the default locale. */
export function getIntlLocale(): string {
  const active = i18n.language
  const pack = orcaI18n.getPluginLanguagePacks().find((entry) => entry.resourceLanguage === active)
  return supportedIntlLocale(pack?.locale ?? active, Intl.DateTimeFormat)
}

export function setRendererPluginLanguagePacks(
  packs: readonly PluginLanguagePackRegistration[]
): void {
  orcaI18n.setPluginLanguagePacks(packs)
}
