import { describe, expect, it } from 'vitest'
import { getGeneralNavigationSearchEntries, getGeneralPaneSearchEntries } from './general-search'
import { matchesSettingsSearch } from './settings-search'

describe('preview tab setting search', () => {
  it.each(['preview', 'reuse', 'italic', 'explorer', 'browsing', 'preview tab'])(
    'keeps the setting reachable through both search gates for "%s"',
    (query) => {
      const navigationEntries = getGeneralNavigationSearchEntries()
      const entry = navigationEntries.find(
        (item) => item.title === 'Reuse a preview tab when browsing files'
      )

      expect(entry).toBeDefined()
      expect(matchesSettingsSearch(query, entry!)).toBe(true)
      // Why: the Navigation section gate hides the whole section, so the outer catalog must match too.
      expect(matchesSettingsSearch(query, navigationEntries)).toBe(true)
      expect(matchesSettingsSearch(query, getGeneralPaneSearchEntries())).toBe(true)
    }
  )
})
