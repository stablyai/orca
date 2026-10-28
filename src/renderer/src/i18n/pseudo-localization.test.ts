import { describe, expect, it } from 'vitest'

import { PSEUDO_LOCALIZATION_LOCALE } from './pseudo-localization'
import { i18n, translate } from './i18n'

describe('pseudo-localization', () => {
  it('applies pseudo wrapping through translate when active', async () => {
    const previous = i18n.language
    await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)
    expect(translate('settings.appearance.language.title', 'Language')).toBe('[Language]')
    await i18n.changeLanguage(previous)
  })
})
