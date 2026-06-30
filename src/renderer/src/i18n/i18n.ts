import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type ReadCallback,
  type TOptions
} from 'i18next'
import { initReactI18next } from 'react-i18next'

import en from './locales/en.json'
import { isPseudoLocalizationLocale, pseudoLocalizeString } from './pseudo-localization'
import { DEFAULT_LOCALE, resolveUiLocale } from './supported-languages'
import type { SupportedUiLocale } from '../../../shared/ui-locale'
import type { UiLanguage } from '../../../shared/ui-language'

export const i18n: I18nInstance = i18next.createInstance()

// Why: only the English catalog is bundled eagerly. The other four locales add
// ~2MB to the renderer's startup chunk (parsed on every launch) even though the
// app always boots in English and only switches after the persisted UI language
// loads. A lazy backend fetches each non-English catalog on demand, so any
// changeLanguage() call (UI switch or test) transparently loads its bundle
// instead of paying the parse cost at cold start.
const NON_DEFAULT_LOCALE_LOADERS: Record<
  Exclude<SupportedUiLocale, 'en'>,
  () => Promise<{ default: Record<string, unknown> }>
> = {
  es: () => import('./locales/es.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  zh: () => import('./locales/zh.json')
}

const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => {},
  read: (language: string, _namespace: string, callback: ReadCallback) => {
    const loader = NON_DEFAULT_LOCALE_LOADERS[language as Exclude<SupportedUiLocale, 'en'>]
    if (!loader) {
      // English (and unknown locales) are served from bundled resources; signal
      // "nothing to load" so i18next falls back to the in-memory catalog.
      callback(null, false)
      return
    }
    loader().then(
      (mod) => callback(null, mod.default),
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
    // Why: `resources` seeds the eager English catalog while
    // `partialBundledLanguages` lets the backend supply the lazy locales — so
    // i18next uses bundled `en` immediately and only hits the backend for the
    // languages that aren't already in memory.
    partialBundledLanguages: true,
    resources: {
      en: {
        translation: en
      }
    },
    interpolation: {
      escapeValue: false
    },
    react: {
      useSuspense: false
    }
  })

export function translate(key: string, fallback: string, options?: TOptions): string {
  const value = i18n.t(key, { defaultValue: fallback, ...options })
  return isPseudoLocalizationLocale(i18n.language) ? pseudoLocalizeString(value) : value
}

export async function setRendererUiLanguage(language: UiLanguage): Promise<void> {
  const locale = resolveUiLocale(language)
  if (i18n.language !== locale) {
    // changeLanguage triggers the lazy backend load for non-English locales and
    // resolves once the catalog is in memory.
    await i18n.changeLanguage(locale)
  }
}
