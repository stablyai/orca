import { describe, expect, it } from 'vitest'

import { getAppearancePaneSearchEntries } from './appearance-search'
import { getWindowTitleEntries } from './appearance-window-title-search'
import { matchesSettingsSearch } from './settings-search'

describe('window title setting search', () => {
  it.each(['window title', 'time tracking', 'ActivityWatch', 'Timing', 'WakaTime', 'RescueTime'])(
    'finds the setting by %s',
    (query) => {
      expect(matchesSettingsSearch(query, getWindowTitleEntries())).toBe(true)
    }
  )

  it('is part of the Appearance pane search', () => {
    expect(matchesSettingsSearch('time tracker', getAppearancePaneSearchEntries())).toBe(true)
  })
})
