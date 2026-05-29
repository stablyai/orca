import { describe, expect, it } from 'vitest'
import { matchesSettingsSearch } from './settings-search'
import { APPEARANCE_PANE_SEARCH_ENTRIES, THEME_ENTRIES } from './appearance-search'

describe('AppearancePane search entries', () => {
  it('surfaces the macOS glass effect from appearance search', () => {
    expect(matchesSettingsSearch('glass', APPEARANCE_PANE_SEARCH_ENTRIES)).toBe(true)
    expect(matchesSettingsSearch('vibrancy', THEME_ENTRIES)).toBe(true)
  })
})
