import { UI_LANGUAGE_SYSTEM, isPluginUiLanguage, type UiLanguage } from './ui-language'

export const SUPPORTED_UI_LOCALES = [
  'en',
  'zh',
  'zh-Hant',
  'ko',
  'ja',
  'es',
  'fr',
  'pt',
  'ru',
  'tr',
  'de'
] as const
export type SupportedUiLocale = (typeof SUPPORTED_UI_LOCALES)[number]

export const DEFAULT_UI_LOCALE: SupportedUiLocale = 'en'

export type UiLanguageDetection = {
  detectedTag: string | null
  status: 'supported' | 'unsupported' | 'unknown'
  locale: SupportedUiLocale
  source: 'native' | 'browser' | 'browser-fallback'
}

export function normalizeUiLocaleTag(value: string | undefined): string | null {
  if (!value || value.length > 128) {
    return null
  }
  const [rawTag, modifier] = value.trim().split('@')
  const tag = rawTag.replace(/\.[A-Za-z0-9-]+$/, '').replace(/_/g, '-')
  if (/^(c|posix)$/i.test(tag)) {
    return null
  }
  try {
    const locale = new Intl.Locale(tag)
    const script = Object.entries({
      hans: 'Hans',
      hant: 'Hant',
      latin: 'Latn',
      cyrillic: 'Cyrl'
    }).find(([name]) => name === modifier?.toLowerCase())?.[1]
    return new Intl.Locale(locale, script ? { script } : undefined).baseName
  } catch {
    return null
  }
}

export type UiLocaleParts = {
  language: string
  script?: string | null
  region?: string | null
}

// Takes parsed subtags so runtimes without Intl.Locale (Hermes) share the same mapping.
export function matchUiLocaleParts({
  language,
  script,
  region
}: UiLocaleParts): SupportedUiLocale | null {
  const base = language.toLowerCase()
  if (base === 'zh') {
    if (script) {
      const scriptName = script.toLowerCase()
      return scriptName === 'hans' ? 'zh' : scriptName === 'hant' ? 'zh-Hant' : null
    }
    return ['TW', 'HK', 'MO'].includes(region?.toUpperCase() ?? '') ? 'zh-Hant' : 'zh'
  }
  return SUPPORTED_UI_LOCALES.find((supported) => supported === base) ?? null
}

function matchUiLocale(tag: string): SupportedUiLocale | null {
  const locale = new Intl.Locale(tag)
  return matchUiLocaleParts({
    language: locale.language,
    script: locale.script,
    region: locale.region
  })
}

export function detectUiLanguage(
  preferences: readonly string[],
  source: UiLanguageDetection['source']
): UiLanguageDetection {
  const detectedTag = preferences.map(normalizeUiLocaleTag).find((tag) => tag !== null) ?? null
  const match = detectedTag ? matchUiLocale(detectedTag) : null
  return {
    detectedTag,
    status: detectedTag ? (match ? 'supported' : 'unsupported') : 'unknown',
    locale: match ?? DEFAULT_UI_LOCALE,
    source
  }
}

export function normalizeSupportedUiLocale(locale: string | undefined): SupportedUiLocale {
  return detectUiLanguage(locale ? [locale] : [], 'browser').locale
}

let rendererDetection: UiLanguageDetection | null = null

export function setRendererLanguageDetection(detection: UiLanguageDetection): void {
  rendererDetection = detection
}

export function getBrowserLanguageDetection(
  source: UiLanguageDetection['source'] = 'browser'
): UiLanguageDetection {
  return detectUiLanguage(
    typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language],
    source
  )
}

export function getRendererLanguageDetection(): UiLanguageDetection {
  return rendererDetection ?? getBrowserLanguageDetection()
}

export function shouldShowLanguageSwitcher(detection: UiLanguageDetection): boolean {
  return (
    detection.source === 'browser-fallback' ||
    detection.status !== 'supported' ||
    detection.locale !== 'en'
  )
}

export function resolveUiLocale(
  language: UiLanguage,
  systemLocale: string | undefined = DEFAULT_UI_LOCALE
): string {
  if (isPluginUiLanguage(language)) {
    return language
  }
  // Built-in UI language values are their own locale codes; only 'system' needs detection.
  return (
    SUPPORTED_UI_LOCALES.find((locale) => locale === language) ??
    normalizeSupportedUiLocale(systemLocale)
  )
}

export function getRendererSystemLocale(): string {
  return getRendererLanguageDetection().locale
}

export function resolveRendererUiLocale(language: UiLanguage): string {
  return resolveUiLocale(
    language,
    language === UI_LANGUAGE_SYSTEM ? getRendererSystemLocale() : DEFAULT_UI_LOCALE
  )
}
