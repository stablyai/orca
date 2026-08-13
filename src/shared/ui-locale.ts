import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM,
  UI_LANGUAGE_TRADITIONAL_CHINESE,
  isPluginUiLanguage,
  type UiLanguage
} from './ui-language'

export const SUPPORTED_UI_LOCALES = ['en', 'zh', 'zh-TW', 'ko', 'ja', 'es'] as const
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: SupportedUiLocale = 'en'

function normalizeLocaleTag(locale: string | undefined): string {
  return (locale ?? DEFAULT_UI_LOCALE).trim().toLowerCase().replace(/_/g, '-')
}

// Traditional-script regions plus the explicit script subtag; everything else under zh is Simplified.
const TRADITIONAL_CHINESE_TAG_PREFIXES = ['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant']

export function normalizeSupportedUiLocale(locale: string | undefined): SupportedUiLocale {
  const tag = normalizeLocaleTag(locale)
  const primary = tag.split('-')[0]
  if (primary === 'zh') {
    return TRADITIONAL_CHINESE_TAG_PREFIXES.some((prefix) => tag.startsWith(prefix))
      ? 'zh-TW'
      : 'zh'
  }
  return SUPPORTED_UI_LOCALES.includes(primary as SupportedUiLocale)
    ? (primary as SupportedUiLocale)
    : DEFAULT_UI_LOCALE
}

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
  if (language === UI_LANGUAGE_TRADITIONAL_CHINESE) {
    return 'zh-TW'
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
