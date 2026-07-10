import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM,
  type UiLanguage
} from './ui-language'

export const SUPPORTED_UI_LOCALES = ['en', 'zh', 'ko', 'ja', 'es'] as const
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: SupportedUiLocale = 'en'

function normalizeLocaleTag(locale: string | undefined): string {
  return (locale ?? DEFAULT_UI_LOCALE).trim().toLowerCase().replace(/_/g, '-')
}

export function normalizeSupportedUiLocale(locale: string | undefined): SupportedUiLocale {
  const tag = normalizeLocaleTag(locale)
  const primary = tag.split('-')[0]
  if (primary === 'zh') {
    if (tag.startsWith('zh-tw') || tag.startsWith('zh-hk') || tag.startsWith('zh-hant')) {
      return DEFAULT_UI_LOCALE
    }
    return 'zh'
  }
  return SUPPORTED_UI_LOCALES.includes(primary as SupportedUiLocale)
    ? (primary as SupportedUiLocale)
    : DEFAULT_UI_LOCALE
}

export function resolveUiLocale(
  language: UiLanguage,
  systemLocale: string | undefined = DEFAULT_UI_LOCALE
): SupportedUiLocale {
  if (language === UI_LANGUAGE_ENGLISH) {
    return DEFAULT_UI_LOCALE
  }
  if (language === UI_LANGUAGE_CHINESE) {
    return 'zh'
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

export function resolveRendererUiLocale(language: UiLanguage): SupportedUiLocale {
  return resolveUiLocale(
    language,
    language === UI_LANGUAGE_SYSTEM ? getRendererSystemLocale() : DEFAULT_UI_LOCALE
  )
}
