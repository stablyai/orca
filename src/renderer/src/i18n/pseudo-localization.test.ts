import { describe, expect, it } from 'vitest'

import {
  isPseudoLocalizationLocale,
  pseudoLocalizeString,
  PSEUDO_LOCALIZATION_LOCALE
} from './pseudo-localization'
import { i18n, translate } from './i18n'

describe('pseudo-localization', () => {
  it('wraps strings for the pseudo locale', () => {
    expect(pseudoLocalizeString('Language')).toBe('[Language]')
    expect(pseudoLocalizeString('[Already wrapped]')).toBe('[Already wrapped]')
  })

  it('recognizes the pseudo locale id', () => {
    expect(isPseudoLocalizationLocale(PSEUDO_LOCALIZATION_LOCALE)).toBe(true)
    expect(isPseudoLocalizationLocale('en')).toBe(false)
  })

  it('applies pseudo wrapping through translate when active', async () => {
    const previous = i18n.language
    await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)
    expect(translate('settings.appearance.language.title', 'Language')).toBe('[Language]')
    await i18n.changeLanguage(previous)
  })
})
