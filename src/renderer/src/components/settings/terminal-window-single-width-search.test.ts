import { describe, expect, it } from 'vitest'
import { matchesSettingsSearch } from './settings-search'
import { getTerminalWindowSearchEntries } from './terminal-window-setup-search'

// The Window section unmounts when this static catalog misses, so a setting
// absent from it is unreachable by search even though its control exists.
describe('single terminal width is reachable from settings search', () => {
  it.each(['single terminal width', 'centered', 'max width', 'wide'])('matches %s', (query) => {
    expect(
      getTerminalWindowSearchEntries().some((entry) => matchesSettingsSearch(query, entry))
    ).toBe(true)
  })
})
