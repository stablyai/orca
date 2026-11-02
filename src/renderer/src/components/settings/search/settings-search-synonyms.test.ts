import { describe, expect, it } from 'vitest'
import { matchesSettingsSearch, rankSettingsSearchItems } from './settings-search'

describe('settings-search synonyms', () => {
  it('matches common aliases and keeps literal matches ranked first', () => {
    const shortcuts = { title: 'Shortcuts', keywords: ['shortcut'] }
    const shortcutAliases = [
      'shortcut',
      'shortcuts',
      'hotkey',
      'hotkeys',
      'keybinding',
      'keybindings',
      'keymap',
      'keymaps',
      'keybind',
      'keybinds'
    ]

    for (const alias of shortcutAliases) {
      expect(matchesSettingsSearch(alias, shortcuts), alias).toBe(true)
      expect(matchesSettingsSearch(`  ${alias.toUpperCase()}  `, shortcuts), alias).toBe(true)
    }

    for (const alias of ['settings', 'preferences', 'options', 'config']) {
      expect(matchesSettingsSearch(alias, { title: 'Settings' }), alias).toBe(true)
    }

    expect(matchesSettingsSearch('hotkey editor', shortcuts)).toBe(false)
    expect(matchesSettingsSearch('myhotkey', shortcuts)).toBe(false)
    expect(matchesSettingsSearch('unrecognized', shortcuts)).toBe(false)

    const results = rankSettingsSearchItems(
      'hotkey',
      [
        { id: 'appearanceKeyword', entry: { title: 'Appearance', keywords: ['shortcut'] } },
        { id: 'shortcutsPane', entry: { title: 'Shortcuts' } },
        { id: 'literalKeyword', entry: { title: 'Keyboard', keywords: ['hotkey'] } }
      ],
      (item) => item.entry
    )
    expect(results.map(({ item }) => item.id)).toEqual([
      'literalKeyword',
      'shortcutsPane',
      'appearanceKeyword'
    ])
    expect(results[0].score).toBeGreaterThan(results[1].score)
    expect(results[1].score).toBeGreaterThan(results[2].score)
  })
})
