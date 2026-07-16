import { beforeEach, describe, expect, it } from 'vitest'

import {
  UI_LANGUAGE_CHINESE,
  UI_LANGUAGE_CHINESE_TRADITIONAL,
  UI_LANGUAGE_ENGLISH,
  UI_LANGUAGE_SPANISH
} from '../../../shared/ui-language'
import { i18n, setRendererUiLanguage } from './i18n'

// Why: the renderer now lazy-loads non-English catalogs through an i18next
// backend instead of bundling all five into the startup chunk. This guards the
// invariant that switching language (I18nProvider effect / Settings) resolves
// real translations once changeLanguage() settles — and that any direct
// i18n.changeLanguage() call (used across the codebase and tests) transparently
// loads its catalog. A regression would silently show English to a user who
// picked another language.

describe('renderer i18n lazy locale loading', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('serves English synchronously from the eager bundle', () => {
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('File')
  })

  it('lazy-loads Spanish via setRendererUiLanguage before it resolves', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(i18n.language).toBe('es')
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')
  })

  it('lazy-loads a catalog through a direct changeLanguage call', async () => {
    await i18n.changeLanguage(UI_LANGUAGE_CHINESE)
    expect(i18n.t('menu.settings', { defaultValue: 'Settings' })).toBe('设置')
  })

  it('lazy-loads Traditional Chinese through the explicit UI setting', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_CHINESE_TRADITIONAL)
    expect(i18n.language).toBe('zh-TW')
    expect(i18n.options.load).toBe('currentOnly')
    expect(i18n.t('menu.settings', { defaultValue: 'Settings' })).toBe('設置')
  })

  it('returns to English from a lazily-loaded locale', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('Archivo')

    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
    expect(i18n.t('menu.file', { defaultValue: 'File' })).toBe('File')
  })
})
