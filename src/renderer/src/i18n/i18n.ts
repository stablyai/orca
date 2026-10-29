import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'
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
import { isPseudoLocalizationLocale, pseudoLocalizeString } from './pseudo-localization'
import {
  advanceTranslationResourceVersion,
  getTranslationResourceVersion
} from './translation-resource-version'
import { DEFAULT_LOCALE, resolveUiLocale } from './supported-languages'
import type { SupportedUiLocale } from '../../../shared/ui-locale'
import { isPluginUiLanguage, type UiLanguage } from '../../../shared/ui-language'
import type { PluginLanguagePackRegistration } from '../../../shared/plugins/plugin-language-pack-artifact'
import { replacePluginLanguagePackResources } from '../../../shared/plugins/plugin-language-pack-i18n-resources'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import {
  resolvePluralFamilyKey,
  withPluralCategoriesFromOther
} from '../../../shared/i18n-plural-family'

export const i18n: I18nInstance = i18next.createInstance()

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

function localeCatalogUrl(language: string): string | undefined {
  return Object.entries(NON_DEFAULT_LOCALE_URLS).find(([name]) => name === language)?.[1]
}

async function loadLocaleCatalog(language: string, url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { cache: 'no-cache' })
  if (!response.ok) {
    throw new Error(`Language catalog request failed: ${response.status}`)
  }
  const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories
  return withPluralCategoriesFromOther(await response.json(), categories)
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const url = localeCatalogUrl(language)
    if (!url) {
      // Bundled English/unknown locales need no backend load; let i18next use in-memory fallback.
      callback(null, false)
      return
    }
    loadLocaleCatalog(language, url).then(
      (catalog) => callback(null, catalog),
      (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
    )
  }
}

void i18n
  .use(lazyLocaleBackend)
  .use(initReactI18next)
  .init({
    fallbackLng: DEFAULT_LOCALE,
    lng: DEFAULT_LOCALE,
    // Default 'all' expands zh-Hant to [zh-Hant, zh, en], so missing keys would render Simplified.
    load: 'currentOnly',
    // Serve eager English from resources while the backend lazily supplies other languages.
    partialBundledLanguages: true,
    resources: {
      en: {
        // Inline defaults cover most English; sync:localization-runtime-catalog retains plural/dynamic/edited entries. en.json remains the translator source for lazy catalogs.
        translation: enRuntimeRequired
      }
    },
    // An empty catalog value falls back to English instead of rendering blank.
    returnEmptyString: false,
    interpolation: {
      escapeValue: false
    },
    react: {
      useSuspense: false
    }
  })

// Plugin packs can replace translations without changing the active language.
i18n.store.on('added', advanceTranslationResourceVersion)
i18n.store.on('removed', advanceTranslationResourceVersion)
i18n.on('languageChanged', advanceTranslationResourceVersion)

// Re-rendered chrome resolves hundreds of option-free strings per workspace switch; they only change with language or resources.
const PLAIN_TRANSLATION_CACHE_LIMIT = 5000
const plainTranslationCache = new Map<string, string>()
let plainTranslationCacheScope = ''

function translateUncached(key: string, fallback: string, options?: TOptions): string {
  const value = i18n.t(resolvePluralFamilyKey(key, options), { defaultValue: fallback, ...options })
  return isPseudoLocalizationLocale(i18n.language) ? pseudoLocalizeString(value) : value
}

export function translate(key: string, fallback: string, options?: TOptions): string {
  if (options !== undefined) {
    return translateUncached(key, fallback, options)
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
  const value = translateUncached(key, fallback)
  plainTranslationCache.set(cacheKey, value)
  return value
}

export async function loadRendererUiLanguage(language: UiLanguage): Promise<string> {
  const resolved = resolveUiLocale(language)
  const resourceLanguage = resolveRendererResourceLanguage(resolved)
  const locale =
    isPluginUiLanguage(language) && resourceLanguage === resolved
      ? DEFAULT_LOCALE
      : resourceLanguage
  const url = localeCatalogUrl(locale)
  if (url && !i18n.hasResourceBundle(locale, 'translation')) {
    const catalog = await withTimeout(loadLocaleCatalog(locale, url), 5000, null)
    if (catalog === null) {
      throw new Error('Language catalog unavailable')
    }
    i18n.addResourceBundle(locale, 'translation', catalog, true, true)
  }
  return locale
}

export async function setRendererUiLanguage(language: UiLanguage): Promise<void> {
  const locale = await loadRendererUiLanguage(language)
  if (i18n.language !== locale) {
    await i18n.changeLanguage(locale)
  }
}

let pluginLanguagePacks: readonly PluginLanguagePackRegistration[] = []

/** Resolve an Intl-compatible BCP-47 tag: plugin pack resources use the pack’s declared tag, then the default locale. */
export function getIntlLocale(): string {
  const active = i18n.language
  const pack = pluginLanguagePacks.find((entry) => entry.resourceLanguage === active)
  return supportedIntlLocale(pack?.locale ?? active, Intl.DateTimeFormat)
}

function supportedIntlLocale(
  locale: string,
  intl: { supportedLocalesOf(locale: string): string[] }
): string {
  try {
    // An unsupported tag would silently use the runtime locale; explicitly fall back to the default.
    return intl.supportedLocalesOf(locale)[0] ?? DEFAULT_LOCALE
  } catch {
    return DEFAULT_LOCALE
  }
}

export function resolveRendererResourceLanguage(language: string): string {
  return pluginLanguagePacks.find((pack) => pack.id === language)?.resourceLanguage ?? language
}

export function setRendererPluginLanguagePacks(
  packs: readonly PluginLanguagePackRegistration[]
): void {
  replacePluginLanguagePackResources(i18n, pluginLanguagePacks, packs)
  pluginLanguagePacks = packs
}
