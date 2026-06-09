import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SYSTEM, type UiLanguage } from './ui-language'

export const SUPPORTED_UI_LOCALES = ['en'] as const
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: SupportedUiLocale = 'en'

export function normalizeSupportedUiLocale(locale: string | undefined): SupportedUiLocale {
  const primary = (locale ?? DEFAULT_UI_LOCALE).split('-')[0]?.toLowerCase()
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
