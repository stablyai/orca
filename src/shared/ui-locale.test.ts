import { describe, expect, it } from 'vitest'

import { normalizeSupportedUiLocale, resolveUiLocale, resolveRendererUiLocale } from './ui-locale'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SYSTEM } from './ui-language'

describe('ui-locale', () => {
  it('normalizes supported locale prefixes', () => {
    expect(normalizeSupportedUiLocale('en-US')).toBe('en')
    expect(normalizeSupportedUiLocale('ko-KR')).toBe('en')
  })

  it('resolves explicit English independently of system locale', () => {
    expect(resolveUiLocale(UI_LANGUAGE_ENGLISH, 'ko-KR')).toBe('en')
  })

  it('maps system locale to English until more locales ship', () => {
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'en-GB')).toBe('en')
    expect(resolveUiLocale(UI_LANGUAGE_SYSTEM, 'fr-FR')).toBe('en')
  })

  it('uses renderer system locale only for the system setting', () => {
    expect(resolveRendererUiLocale(UI_LANGUAGE_ENGLISH)).toBe('en')
    expect(resolveRendererUiLocale(UI_LANGUAGE_SYSTEM)).toBe('en')
  })
})
