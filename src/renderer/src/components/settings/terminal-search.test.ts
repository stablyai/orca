import { describe, expect, it } from 'vitest'
import { getTerminalPaneSearchEntries } from './terminal-search'
import { matchesSettingsSearch } from './settings-search'

describe('getTerminalPaneSearchEntries shell history', () => {
  it('includes the shell history opt-out on all platforms', () => {
    const platforms = [
      { isWindows: true, isMac: false },
      { isWindows: false, isMac: true },
      { isWindows: false, isMac: false }
    ]

    for (const platform of platforms) {
      const entries = getTerminalPaneSearchEntries(platform)
      expect(
        entries.some((entry) => entry.title === 'Scope bash, zsh, and fish history by workspace')
      ).toBe(true)
    }
  })

  it.each(['history', 'worktree', 'autosuggestions', 'Ctrl+R', 'HISTFILE', 'fish'])(
    'finds the shell history opt-out by searching %s',
    (query) => {
      const entries = getTerminalPaneSearchEntries({ isWindows: false, isMac: false }).filter(
        (entry) => entry.title === 'Scope bash, zsh, and fish history by workspace'
      )

      expect(entries).toHaveLength(1)
      expect(matchesSettingsSearch(query, entries)).toBe(true)
    }
  )
})
