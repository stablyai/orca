import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { getGeneralPaneSearchEntries, getHoldQuitEntries } from './general-search'
import { getAppearancePaneSearchEntries } from './appearance-search'
import { matchesSettingsSearch } from './settings-search'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('hold-to-quit settings discovery', () => {
  it.each(['en', 'ru'])(
    'finds the General setting by shortcut and behavior in %s',
    async (locale) => {
      await i18n.changeLanguage(locale)
      const entries = getGeneralPaneSearchEntries({ showHoldQuit: true })
      for (const query of ['Cmd+Q', '⌘Q', 'quit', 'close', 'выход', 'удержание']) {
        expect(matchesSettingsSearch(query, entries)).toBe(true)
        expect(matchesSettingsSearch(query, getHoldQuitEntries({ showHoldQuit: true }))).toBe(true)
      }
      expect(matchesSettingsSearch('Cmd+Q', getAppearancePaneSearchEntries())).toBe(false)
      expect(
        matchesSettingsSearch('Cmd+Q', getGeneralPaneSearchEntries({ showHoldQuit: false }))
      ).toBe(false)
    }
  )
})
