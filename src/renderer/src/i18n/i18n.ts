import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'
import { initReactI18next } from 'react-i18next'

import enRuntimeRequired from './en-runtime-required.json'
import esCatalogUrl from './locales/es.json?url'
import frCatalogUrl from './locales/fr.json?url'
import jaCatalogUrl from './locales/ja.json?url'
import koCatalogUrl from './locales/ko.json?url'
import ptCatalogUrl from './locales/pt.json?url'
import zhCatalogUrl from './locales/zh.json?url'
import { isPseudoLocalizationLocale, pseudoLocalizeString } from './pseudo-localization'
import { advanceTranslationResourceVersion } from './translation-resource-version'
import { DEFAULT_LOCALE, resolveUiLocale } from './supported-languages'
import type { SupportedUiLocale } from '../../../shared/ui-locale'
import { isPluginUiLanguage, type UiLanguage } from '../../../shared/ui-language'
import {
  isCatalogObject,
  type PluginLanguagePackRegistration
} from '../../../shared/plugins/plugin-language-pack-artifact'
import { withTimeout } from '../../../shared/promise-timeout-fallback'

export const i18n: I18nInstance = i18next.createInstance()

// Fetch catalogs as data: Chromium caches rejected module imports for the document's lifetime.
const NON_DEFAULT_LOCALE_URLS: Record<Exclude<SupportedUiLocale, 'en'>, string> = {
  es: esCatalogUrl,
  fr: frCatalogUrl,
  ja: jaCatalogUrl,
  ko: koCatalogUrl,
  pt: ptCatalogUrl,
  zh: zhCatalogUrl
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
    // Serve eager English from resources while the backend lazily supplies other languages.
    partialBundledLanguages: true,
    resources: {
      en: {
        // Inline defaults cover most English; sync:localization-runtime-catalog retains plural/dynamic/edited entries. en.json remains the translator source for lazy catalogs.
        translation: enRuntimeRequired
      }
    },
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

// Synthetic plugin<hex> tags would get English plurals; plugin-pack-plurals.test.ts guards i18next upgrades.
const pluralLocaleByResourceLanguage = new Map<string, string>()
const pluralResolver = i18n.services.pluralResolver
const getPluralRule = pluralResolver.getRule.bind(pluralResolver)
pluralResolver.getRule = (code: string, options?: { ordinal?: boolean }) =>
  getPluralRule(pluralLocaleByResourceLanguage.get(code) ?? code, options)

const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/

export function translate(key: string, fallback: string, options?: TOptions): string {
  // Callers name a literal `_one`/`_other` key for extraction; with a count, let CLDR pick the form.
  const resolvedKey = typeof options?.count === 'number' ? key.replace(PLURAL_SUFFIX_RE, '') : key
  const value = i18n.t(resolvedKey, { defaultValue: fallback, ...options })
  return isPseudoLocalizationLocale(i18n.language) ? pseudoLocalizeString(value) : value
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

const registeredPluginLanguages = new Set<string>()
let pluginLanguagePacks: readonly PluginLanguagePackRegistration[] = []

/** Resolve an Intl-compatible BCP-47 tag: synthetic plugin<hex> resource names use the pack’s declared tag, then the default locale. */
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

// Catalogs translated from English often ship only _one/_other; reuse _other so few/many stay in-language.
function withPluralCategoriesFromOther(
  catalog: Record<string, unknown>,
  categories: readonly string[]
): Record<string, unknown> {
  const filled: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(catalog)) {
    filled[key] = isCatalogObject(value) ? withPluralCategoriesFromOther(value, categories) : value
    if (typeof value === 'string' && key.endsWith('_other')) {
      const base = key.slice(0, -'_other'.length)
      for (const category of categories) {
        filled[`${base}_${category}`] ??= value
      }
    }
  }
  return filled
}

export function setRendererPluginLanguagePacks(
  packs: readonly PluginLanguagePackRegistration[]
): void {
  for (const language of registeredPluginLanguages) {
    i18n.removeResourceBundle(language, 'translation')
  }
  registeredPluginLanguages.clear()
  pluralLocaleByResourceLanguage.clear()
  pluginLanguagePacks = packs
  for (const pack of packs) {
    const pluralLocale = supportedIntlLocale(pack.locale, Intl.PluralRules)
    pluralLocaleByResourceLanguage.set(pack.resourceLanguage, pluralLocale)
    const categories = new Intl.PluralRules(pluralLocale).resolvedOptions().pluralCategories
    i18n.addResourceBundle(
      pack.resourceLanguage,
      'translation',
      withPluralCategoriesFromOther(pack.catalog, categories),
      true,
      true
    )
    registeredPluginLanguages.add(pack.resourceLanguage)
  }
}
