import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_CHINESE_TRADITIONAL,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_FRENCH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM,
  isPluginUiLanguage,
  type UiLanguage
} from './ui-language'

export const SUPPORTED_UI_LOCALES = ['en', 'zh', 'zh-Hant', 'ko', 'ja', 'es', 'fr'] as const
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: SupportedUiLocale = 'en'

const TRADITIONAL_CHINESE_TAG_PREFIXES = ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant']

/**
 * Normalizes a locale tag to the same lowercase, hyphenated form used by the app.
 */
function normalizeLocaleTag(locale: string | undefined): string {
  return (locale ?? DEFAULT_UI_LOCALE).trim().toLowerCase().replace(/_/g, '-')
}

/**
 * Maps any system locale to the closest supported app locale, with zh-Hant handled as Taiwan/Traditional Chinese.
 */
export function normalizeSupportedUiLocale(locale: string | undefined): SupportedUiLocale {
  const tag = normalizeLocaleTag(locale)
  const primary = tag.split('-')[0]
  if (primary === 'zh') {
    if (TRADITIONAL_CHINESE_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))) {
      return 'zh-Hant'
    }
    return 'zh'
  }
  return SUPPORTED_UI_LOCALES.includes(primary as SupportedUiLocale)
    ? (primary as SupportedUiLocale)
    : DEFAULT_UI_LOCALE
}

/**
 * Resolves the UI locale to a built-in catalog identifier, regardless of the system locale.
 */
export function resolveUiLocale(
  language: UiLanguage,
  systemLocale: string | undefined = DEFAULT_UI_LOCALE
): string {
  if (isPluginUiLanguage(language)) {
    return language
  }
  if (language === UI_LANGUAGE_ENGLISH) {
    return DEFAULT_UI_LOCALE
  }
  if (language === UI_LANGUAGE_CHINESE) {
    return 'zh'
  }
  if (language === UI_LANGUAGE_CHINESE_TRADITIONAL) {
    return 'zh-Hant'
  }
  if (language === UI_LANGUAGE_KOREAN) {
    return 'ko'
  }
  if (language === UI_LANGUAGE_JAPANESE) {
    return 'ja'
  }
  if (language === UI_LANGUAGE_SPANISH) {
    return 'es'
  }
  if (language === UI_LANGUAGE_FRENCH) {
    return 'fr'
  }
  return normalizeSupportedUiLocale(systemLocale)
}

export function getRendererSystemLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language
  }
  return DEFAULT_UI_LOCALE
}

export function resolveRendererUiLocale(language: UiLanguage): string {
  return resolveUiLocale(
    language,
    language === UI_LANGUAGE_SYSTEM ? getRendererSystemLocale() : DEFAULT_UI_LOCALE
  )
}
