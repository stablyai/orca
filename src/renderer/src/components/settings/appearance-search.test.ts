import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { getLanguageEntries } from './appearance-search'
import { matchesSettingsSearch } from './settings-search'

// Native word for "language" in each supported UI language. These must be
// findable no matter which locale the interface is currently rendered in, so a
// speaker can locate (and switch to) their language from any starting point.
const NATIVE_LANGUAGE_WORDS = ['语言', '語言', '언어', '言語', 'Idioma']

describe('getLanguageEntries', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each(['en', 'zh', 'ko', 'ja', 'es', 'pt'])(
    'indexes every native word for "language" under the %s UI locale',
    async (locale) => {
      await i18n.changeLanguage(locale)
      const entry = getLanguageEntries()[0]
      for (const word of NATIVE_LANGUAGE_WORDS) {
        expect(matchesSettingsSearch(word, entry)).toBe(true)
      }
    }
  )

  it.each(['Español', 'Português (Brasil)'])(
    'matches the %s native language name in English UI',
    async (languageName) => {
      await i18n.changeLanguage('en')
      expect(matchesSettingsSearch(languageName, getLanguageEntries()[0])).toBe(true)
    }
  )
})
