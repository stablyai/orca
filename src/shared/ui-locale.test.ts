import { describe, expect, it } from 'vitest'

import {
  normalizeSupportedUiLocale,
  resolveUiLocale,
  detectUiLanguage,
  normalizeUiLocaleTag,
  shouldShowLanguageSwitcher
} from './ui-locale'
import { UI_LANGUAGE_GERMAN, UI_LANGUAGE_RUSSIAN, UI_LANGUAGE_SYSTEM } from './ui-language'

describe('ui-locale', () => {
  it.each(['ru', 'ru-RU', 'ru-KZ', 'ru_RU.UTF-8'])('resolves Russian %s', (tag) => {
    expect(detectUiLanguage([tag], 'native')).toMatchObject({ locale: 'ru', status: 'supported' })
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, tag)).toBe('ru')
    expect(resolveUiLocale(UI_LANGUAGE_RUSSIAN, 'en-US')).toBe('ru')
    expect(shouldShowLanguageSwitcher(detectUiLanguage([tag], 'native'))).toBe(true)
  })
  it.each(['de', 'de-DE', 'de-AT', 'de-CH', 'de_DE.UTF-8'])('resolves German %s', (tag) => {
    expect(detectUiLanguage([tag], 'native')).toMatchObject({ locale: 'de', status: 'supported' })
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, tag)).toBe('de')
    expect(resolveUiLocale(UI_LANGUAGE_GERMAN, 'en-US')).toBe('de')
  })
  it('maps Traditional Chinese system locales to zh-Hant and keeps Simplified on zh', () => {
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant']) {
      expect(normalizeSupportedUiLocale(tag)).toBe('zh-Hant')
    }
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans']) {
      expect(normalizeSupportedUiLocale(tag)).toBe('zh')
    }
  })

  it('preserves a selected plugin language bundle id', () => {
    expect(resolveUiLocale('plugin:samples.portuguese/pt-BR')).toBe(
      'plugin:samples.portuguese/pt-BR'
    )
  })
})

describe('system language detection', () => {
  it.each([
    ['en-US', 'en', 'supported'],
    ['fr_CA.UTF-8', 'fr', 'supported'],
    ['pt-PT', 'pt', 'supported'],
    ['tr_TR.UTF-8', 'tr', 'supported'],
    ['zh-Hans-TW', 'zh', 'supported'],
    ['zh-Hant-CN', 'zh-Hant', 'supported'],
    ['zh-Latn-CN', 'en', 'unsupported'],
    ['zh-MO', 'zh-Hant', 'supported'],
    ['zh_CN.UTF-8@hant', 'zh-Hant', 'supported'],
    ['zh_TW.UTF-8@hans', 'zh', 'supported'],
    ['it-IT', 'en', 'unsupported'],
    ['en--US', 'en', 'unknown'],
    ['C.UTF-8', 'en', 'unknown'],
    ['POSIX', 'en', 'unknown']
  ])('resolves %s without confusing a fallback with detected English', (tag, locale, status) => {
    expect(detectUiLanguage([tag], 'native')).toMatchObject({ locale, status })
  })

  it('retains an unsupported primary instead of using a supported secondary', () => {
    expect(detectUiLanguage(['it-IT', 'fr-FR', 'C'], 'native')).toMatchObject({
      detectedTag: 'it-IT',
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
