import i18next, {
  type BackendModule,
  type i18n as I18nInstance,
  type InitOptions,
  type Module,
  type ReadCallback,
  type TOptions
} from 'i18next'
import { isPseudoLocalizationLocale, pseudoLocalizeString } from './pseudo-localization'
import { DEFAULT_UI_LOCALE } from './ui-locale'
import type { PluginLanguagePackRegistration } from './plugins/artifacts/plugin-language-pack-artifact'
import { replacePluginLanguagePackResources } from './plugins/plugin-language-pack-i18n-resources'

export type OrcaI18n = {
  i18n: I18nInstance
  translate: (key: string, fallback: string, options?: TOptions) => string
  /** Returns whether any pack's resources changed. */
  setPluginLanguagePacks: (packs: readonly PluginLanguagePackRegistration[]) => boolean
  getPluginLanguagePacks: () => readonly PluginLanguagePackRegistration[]
  /** Maps a resolved UI locale to its i18next resource language; an unknown pack falls back to English. */
  resolveResourceLanguage: (locale: string) => string
}

const ENGLISH_PLURAL_RULES = new Intl.PluralRules(DEFAULT_UI_LOCALE)

/** Main and renderer share one setup; only how a built-in catalog loads differs. */
export function createOrcaI18n(options: {
  /** Undefined for English and unknown locales, which use caller fallbacks. */
  loadCatalog: (language: string) => Promise<Record<string, unknown>> | undefined
  englishResources: Record<string, unknown>
  modules?: Module[]
  initOptions?: InitOptions
}): OrcaI18n {
  const i18n = i18next.createInstance()
  let pluginLanguagePacks: readonly PluginLanguagePackRegistration[] = []

  const backend: BackendModule = {
    type: 'backend',
    init: () => {},
    read: (language: string, _namespace: string, callback: ReadCallback) => {
      const load = options.loadCatalog(language)
      if (!load) {
        callback(null, false)
        return
      }
      load.then(
        (catalog) => callback(null, catalog),
        (error) => callback(error instanceof Error ? error : new Error(String(error)), false)
      )
    }
  }

  i18n.use(backend)
  for (const module of options.modules ?? []) {
    i18n.use(module)
  }
  // In-memory resources make init synchronous, so callers can translate at module load.
  void i18n.init({
    fallbackLng: DEFAULT_UI_LOCALE,
    lng: DEFAULT_UI_LOCALE,
    // Default 'all' expands zh-Hant to [zh-Hant, zh, en], so missing keys would render Simplified.
    load: 'currentOnly',
    // Serve eager English from resources while the backend lazily supplies other languages.
    partialBundledLanguages: true,
    resources: { [DEFAULT_UI_LOCALE]: { translation: options.englishResources } },
    // An empty catalog value falls back to English instead of rendering blank.
    returnEmptyString: false,
    interpolation: { escapeValue: false },
    ...options.initOptions
  })

  return {
    i18n,
    translate: (key, fallback, translateOptions) => {
      const { defaultValue_one: one, count, ...others } = translateOptions ?? {}
      // A pass-through `count: undefined` must interpolate like an absent count.
      const rest = count === undefined ? others : { ...others, count }
      // i18next would pick the English default by the active language's rule (ru 21 -> _one); English text needs English's.
      const defaultValue =
        typeof one === 'string' &&
        typeof count === 'number' &&
        ENGLISH_PLURAL_RULES.select(count) === 'one'
          ? one
          : fallback
      const value = i18n.t(key, { defaultValue, ...rest })
      return isPseudoLocalizationLocale(i18n.language) ? pseudoLocalizeString(value) : value
    },
    setPluginLanguagePacks: (packs) => {
      if (packs === pluginLanguagePacks) {
        return false
      }
      const changed = replacePluginLanguagePackResources(i18n, pluginLanguagePacks, packs)
      pluginLanguagePacks = packs
      return changed.size > 0
    },
    getPluginLanguagePacks: () => pluginLanguagePacks,
    resolveResourceLanguage: (locale) =>
      pluginLanguagePacks.find((pack) => pack.id === locale)?.resourceLanguage ??
      (locale.startsWith('plugin:') ? DEFAULT_UI_LOCALE : locale)
  }
}
