import { describe, expect, it } from 'vitest'

import {
  normalizeSupportedUiLocale,
  detectUiLanguage,
  normalizeUiLocaleTag,
  shouldShowLanguageSwitcher
} from './ui-locale'
describe('ui-locale', () => {
  it('maps Traditional Chinese system locales to zh-Hant and keeps Simplified on zh', () => {
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant']) {
      expect(normalizeSupportedUiLocale(tag)).toBe('zh-Hant')
    }
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans']) {
      expect(normalizeSupportedUiLocale(tag)).toBe('zh')
    }
  })
})

describe('system language detection', () => {
  it.each([
    ['en-US', 'en', 'supported'],
    ['fr_CA.UTF-8', 'fr', 'supported'],
    ['pt-PT', 'pt', 'supported'],
    ['gl-ES', 'gl', 'supported'],
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
