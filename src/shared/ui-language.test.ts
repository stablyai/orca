import { describe, expect, it } from 'vitest'

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_JAPANESE,
  UI_LANGUAGE_KOREAN,
  UI_LANGUAGE_SPANISH,
  UI_LANGUAGE_SYSTEM,
  normalizeUiLanguage
} from './ui-language'

describe('normalizeUiLanguage', () => {
  it('accepts supported language settings', () => {
    expect(normalizeUiLanguage(UI_LANGUAGE_SYSTEM)).toBe('system')
    expect(normalizeUiLanguage(UI_LANGUAGE_ENGLISH)).toBe('en')
    expect(normalizeUiLanguage(UI_LANGUAGE_CHINESE)).toBe('zh')
    expect(normalizeUiLanguage(UI_LANGUAGE_KOREAN)).toBe('ko')
    expect(normalizeUiLanguage(UI_LANGUAGE_JAPANESE)).toBe('ja')
    expect(normalizeUiLanguage(UI_LANGUAGE_SPANISH)).toBe('es')
  })

  it('falls back unknown values to system', () => {
    expect(normalizeUiLanguage('fr')).toBe('system')
    expect(normalizeUiLanguage(null)).toBe('system')
  })
})
