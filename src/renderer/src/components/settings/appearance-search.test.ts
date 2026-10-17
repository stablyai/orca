import { afterEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { getFollowSymlinkedDirectoriesEntry, getLanguageEntries } from './appearance-search'
import {
  getChatAppearanceEntriesByKey,
  getChatAppearanceSearchEntries
} from './chat-appearance-search'
import { matchesSettingsSearch } from './settings-search'

// Native word for "language" in each supported UI language. These must be
// findable no matter which locale the interface is currently rendered in, so a
// speaker can locate (and switch to) their language from any starting point.
const NATIVE_LANGUAGE_WORDS = ['语言', '語言', '언어', '言語', 'Idioma', 'Langue']

describe('getLanguageEntries', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each(['en', 'zh', 'ko', 'ja', 'es', 'fr'])(
    'indexes every native word for "language" under the %s UI locale',
    async (locale) => {
      await i18n.changeLanguage(locale)
      const entry = getLanguageEntries()[0]
      for (const word of NATIVE_LANGUAGE_WORDS) {
        expect(matchesSettingsSearch(word, entry)).toBe(true)
      }
    }
  )

  it.each(['en', 'ko'])('keeps every symlink search alias in the %s UI locale', async (locale) => {
    await i18n.changeLanguage(locale)
    const entry = getFollowSymlinkedDirectoriesEntry()
    for (const keyword of ['symlink', 'linked folder', 'quick open', 'file explorer']) {
      expect(entry.keywords).toContain(keyword)
      expect(matchesSettingsSearch(keyword, entry)).toBe(true)
    }
  })

  it('matches the Spanish native language name in English UI', async () => {
    await i18n.changeLanguage('en')
    expect(matchesSettingsSearch('Español', getLanguageEntries()[0])).toBe(true)
  })

  it('matches the French native language name in English UI', async () => {
    await i18n.changeLanguage('en')
    expect(matchesSettingsSearch('Français', getLanguageEntries()[0])).toBe(true)
  })
})

describe('chat text weight search', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each([
    ['en', ['Light', 'Regular', 'Medium']],
    ['zh', ['轻', '标准', '中等']],
    ['ja', ['細字', '標準', '中太']],
    ['ko', ['가늘게', '보통', '중간']],
    ['es', ['Ligero', 'Normal', 'Medio']],
    ['fr', ['Léger', 'Normal', 'Moyen']]
  ] as const)('finds the weight row by each localized option in %s', async (locale, labels) => {
    await i18n.changeLanguage('en')
    getChatAppearanceEntriesByKey()
    await i18n.changeLanguage(locale)
    const entry = getChatAppearanceEntriesByKey().textWeight
    for (const label of labels) {
      expect(entry.keywords).toContain(label)
      expect(matchesSettingsSearch(label, entry), label).toBe(true)
      expect(matchesSettingsSearch(label, getChatAppearanceSearchEntries()), label).toBe(true)
    }
  })
})
