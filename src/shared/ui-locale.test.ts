import { describe, expect, it } from 'vitest'

import {
  normalizeSupportedUiLocale,
  resolveUiLocale,
  detectUiLanguage,
  normalizeUiLocaleTag,
  shouldShowLanguageSwitcher
} from './ui-locale'
import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_FRENCH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_PORTUGUESE,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM
} from './ui-language'

describe('ui-locale', () => {
  it('normalizes supported locale prefixes', () => {
    expect(normalizeSupportedUiLocale('en-US')).toBe('en')
    expect(normalizeSupportedUiLocale('zh-CN')).toBe('zh')
    expect(normalizeSupportedUiLocale('zh-Hans')).toBe('zh')
    expect(normalizeSupportedUiLocale('zh-SG')).toBe('zh')
  })

  it('normalizes Portuguese locale prefixes', () => {
    expect(normalizeSupportedUiLocale('pt-BR')).toBe('pt')
    expect(normalizeSupportedUiLocale('pt-PT')).toBe('pt')
    expect(normalizeSupportedUiLocale('pt')).toBe('pt')
  })
  it('falls back unsupported locales to English', () => {
    expect(normalizeSupportedUiLocale('de-DE')).toBe('en')
  })

  it('does not map Traditional Chinese to Simplified yet', () => {
    expect(normalizeSupportedUiLocale('zh-TW')).toBe('en')
    expect(normalizeSupportedUiLocale('zh-HK')).toBe('en')
    expect(normalizeSupportedUiLocale('zh-Hant')).toBe('en')
  })

  it('resolves explicit English independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_ENGLISH, 'zh-CN')).toBe('en')
  })

  it('resolves explicit Chinese independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_CHINESE, 'en-US')).toBe('zh')
  })

  it('resolves explicit Korean independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_KOREAN, 'en-US')).toBe('ko')
  })

  it('resolves explicit Japanese independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_JAPANESE, 'en-US')).toBe('ja')
  })

  it('resolves explicit Spanish independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_SPANISH, 'en-US')).toBe('es')
  })

  it('resolves explicit French independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_FRENCH, 'en-US')).toBe('fr')
  })

  it('resolves explicit Portuguese independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_PORTUGUESE, 'en-US')).toBe('pt')
  })

  it('preserves a selected plugin language bundle id', () => {
    expect(resolveUiLocale('plugin:orca-samples.portuguese/pt-BR')).toBe(
      'plugin:orca-samples.portuguese/pt-BR'
    )
  })

  it('maps system locale to the closest supported locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'en-GB')).toBe('en')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'zh-CN')).toBe('zh')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ko-KR')).toBe('ko')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'ja-JP')).toBe('ja')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'es-MX')).toBe('es')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'fr-FR')).toBe('fr')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'pt-BR')).toBe('pt')
  })
})

describe('system language detection', () => {
  it.each([
    ['en-US', 'en', 'supported'],
    ['fr_CA.UTF-8', 'fr', 'supported'],
    ['pt-PT', 'pt', 'supported'],
    ['zh-Hans-TW', 'zh', 'supported'],
    ['zh-Hant-CN', 'en', 'unsupported'],
    ['zh-Latn-CN', 'en', 'unsupported'],
    ['zh-MO', 'en', 'unsupported'],
    ['zh_CN.UTF-8@hant', 'en', 'unsupported'],
    ['zh_TW.UTF-8@hans', 'zh', 'supported'],
    ['de-DE', 'en', 'unsupported'],
    ['en--US', 'en', 'unknown'],
    ['C.UTF-8', 'en', 'unknown'],
    ['POSIX', 'en', 'unknown']
  ])('resolves %s without confusing a fallback with detected English', (tag, locale, status) => {
    expect(detectUiLanguage([tag], 'native')).toMatchObject({ locale, status })
  })

  it('retains an unsupported primary instead of using a supported secondary', () => {
    expect(detectUiLanguage(['de-DE', 'fr-FR', 'C'], 'native')).toMatchObject({
      detectedTag: 'de-DE',
      locale: 'en',
      status: 'unsupported'
    })
  })

  it('hides only confident English and respects language order', () => {
    const english = detectUiLanguage(['en-GB', 'zh-CN'], 'native')
    expect(shouldShowLanguageSwitcher(english)).toBe(false)
    expect(shouldShowLanguageSwitcher(detectUiLanguage(['en'], 'browser-fallback'))).toBe(true)
    expect(shouldShowLanguageSwitcher(detectUiLanguage(['C', 'garbage!'], 'native'))).toBe(true)
    expect(shouldShowLanguageSwitcher(detectUiLanguage(['zh-CN', 'en-GB'], 'native'))).toBe(true)
  })

  it('preserves script modifiers while normalizing POSIX locales', () => {
    expect(normalizeUiLocaleTag('sr_RS.UTF-8@latin')).toBe('sr-Latn-RS')
    expect(normalizeUiLocaleTag('sr_RS@cyrillic')).toBe('sr-Cyrl-RS')
  })
})
