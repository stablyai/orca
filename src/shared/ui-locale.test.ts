import { describe, expect, it } from 'vitest'

import { detectUiLanguage, shouldShowLanguageSwitcher } from './ui-locale'

describe('system language detection', () => {
  it.each([
    ['en-US', 'en', 'supported'],
    ['gl-ES', 'gl', 'supported'],
    ['zh-Hans-TW', 'zh', 'supported'],
    ['zh-Hant-CN', 'zh-Hant', 'supported'],
    ['zh-Latn-CN', 'en', 'unsupported'],
    ['zh-MO', 'zh-Hant', 'supported'],
    ['zh_CN.UTF-8@hant', 'zh-Hant', 'supported'],
    ['zh_TW.UTF-8@hans', 'zh', 'supported'],
    ['it-IT', 'en', 'unsupported'],
    ['en--US', 'en', 'unknown'],
    ['C.UTF-8', 'en', 'unknown']
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
})
