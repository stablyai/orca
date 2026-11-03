import { describe, expect, it } from 'vitest'
import {
  resolveConfiguredTerminalColors,
  resolveTerminalPalette,
  terminalCustomThemeRemoval,
  withImportedTerminalColorOverrides
} from './terminal-theme-selection'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'

const base = {
  theme: 'system' as const,
  terminalThemeDark: 'Ghostty Default Style Dark',
  terminalUseSeparateLightTheme: true,
  terminalThemeLight: 'Builtin Tango Light'
}

describe('the terminal colours a host configures', () => {
  it('uses the light theme for a light appearance, so a light user is not told dark', () => {
    expect(resolveConfiguredTerminalColors(base, false)).toEqual({
      foreground: '#2e3434',
      background: '#ffffff'
    })
    expect(resolveConfiguredTerminalColors({ ...base, theme: 'light' }, true)).toEqual({
      foreground: '#2e3434',
      background: '#ffffff'
    })
    expect(resolveConfiguredTerminalColors(base, true)).toEqual({
      foreground: '#ffffff',
      background: '#282c34'
    })
  })

  it('follows the selected catalog theme and colour overrides', () => {
    const name = 'Tokyo Night'
    const selected = TERMINAL_THEME_CATALOG[name]
    expect(selected).toBeDefined()
    expect(resolveConfiguredTerminalColors({ ...base, terminalThemeDark: name }, true)).toEqual({
      foreground: selected?.foreground,
      background: selected?.background
    })
    expect(
      resolveConfiguredTerminalColors(
        { ...base, terminalColorOverrides: { background: '#101010' } },
        true
      )
    ).toEqual({ foreground: '#ffffff', background: '#101010' })
    expect(
      resolveConfiguredTerminalColors({ ...base, terminalThemeDark: 'no such theme' }, true)
    ).toEqual({ foreground: '#ffffff', background: '#282c34' })
  })
})

describe('terminal colour overrides per theme slot (#10561)', () => {
  const settings = {
    ...base,
    terminalColorOverrides: { background: '#101010' },
    terminalColorOverridesLight: { foreground: '#202020' }
  }

  it('paints each mode with only its own slot overrides', () => {
    expect(resolveTerminalPalette(settings, true).theme).toMatchObject({
      foreground: '#ffffff',
      background: '#101010'
    })
    expect(resolveTerminalPalette(settings, false).theme).toMatchObject({
      foreground: '#202020',
      background: '#ffffff'
    })
  })

  it('lets light mode that matches dark share the dark slot overrides', () => {
    expect(
      resolveTerminalPalette({ ...settings, terminalUseSeparateLightTheme: false }, false).theme
    ).toMatchObject({ foreground: '#ffffff', background: '#101010' })
  })

  it('merges an imported palette into the slot on screen once the import applies', () => {
    const imported = { terminalColorOverrides: { red: '#ff0000' } }
    expect(withImportedTerminalColorOverrides(settings, imported, false)).toEqual({
      terminalColorOverridesLight: { foreground: '#202020', red: '#ff0000' }
    })
    expect(
      withImportedTerminalColorOverrides(settings, { ...imported, theme: 'dark' }, false)
    ).toEqual({ theme: 'dark', terminalColorOverrides: { background: '#101010', red: '#ff0000' } })
  })

  it('keeps the theme colour for a field cleared in memory', () => {
    expect(
      resolveConfiguredTerminalColors(
        { ...base, terminalColorOverrides: { background: undefined } },
        true
      )
    ).toEqual({ foreground: '#ffffff', background: '#282c34' })
  })
})

describe('plugin terminal palettes', () => {
  const id = 'plugin:samples.dusk/dusk' as const
  const colors = { background: '#1b1430', foreground: '#e8e0ff', red: '#ff6b8b' }

  it('answers a host colour query from the saved palette without the plugin loaded', () => {
    expect(
      resolveConfiguredTerminalColors(
        { ...base, terminalThemeDark: id, terminalPluginPalettes: [{ id, colors }] },
        true
      )
    ).toEqual({ foreground: '#e8e0ff', background: '#1b1430' })
  })

  it('falls back to the default theme for a missing or malformed snapshot', () => {
    const fallback = resolveConfiguredTerminalColors(base, true)
    for (const terminalPluginPalettes of [[], [{ id, colors: { background: 'red;' } }]]) {
      expect(
        resolveConfiguredTerminalColors(
          { ...base, terminalThemeDark: id, terminalPluginPalettes },
          true
        )
      ).toEqual(fallback)
    }
  })

  it('stops painting while its plugin is off and paints again once it is back on', () => {
    const selected = { ...base, terminalThemeDark: id, terminalPluginPalettes: [{ id, colors }] }
    const fallback = resolveConfiguredTerminalColors(base, true)
    expect(
      resolveConfiguredTerminalColors({ ...selected, disabledPlugins: ['samples.dusk'] }, true)
    ).toEqual(fallback)
    expect(
      resolveConfiguredTerminalColors({ ...selected, pluginSystemEnabled: false }, true)
    ).toEqual(fallback)
    expect(
      resolveConfiguredTerminalColors(
        { ...selected, disabledPlugins: ['samples.other'], pluginSystemEnabled: true },
        true
      )
    ).toEqual({ foreground: '#e8e0ff', background: '#1b1430' })
  })
})

describe('deleting an imported terminal theme (#32138)', () => {
  const imported = {
    id: 'warp:dusk',
    name: 'Dusk',
    source: 'warp' as const,
    mode: 'dark' as const,
    terminal: { foreground: '#eeeeee', background: '#101020', red: '#ff5555' },
    importedAt: '2026-01-01T00:00:00.000Z'
  }
  const kept = { ...imported, id: 'warp:dawn', name: 'Dawn' }
  const settings = {
    ...base,
    terminalThemeDark: 'custom:warp:dusk',
    terminalThemeLight: 'custom:warp:dusk',
    terminalCustomThemes: [imported, kept],
    terminalColorOverrides: { background: '#000000' },
    terminalColorOverridesLight: { background: '#ffffff' }
  }

  it('moves every slot showing it back to that slot default, and undo puts it all back', () => {
    const { updates, undo } = terminalCustomThemeRemoval(settings, 'warp:dusk')
    expect(updates).toEqual({
      terminalCustomThemes: [kept],
      terminalThemeDark: 'Ghostty Default Style Dark',
      terminalColorOverrides: undefined,
      terminalThemeLight: 'Builtin Tango Light',
      terminalColorOverridesLight: undefined
    })
    const afterDelete = { ...settings, ...updates, terminalCustomThemes: [kept] }
    expect(undo(afterDelete)).toEqual({
      terminalCustomThemes: [kept, imported],
      terminalThemeDark: 'custom:warp:dusk',
      terminalColorOverrides: { background: '#000000' },
      terminalThemeLight: 'custom:warp:dusk',
      terminalColorOverridesLight: { background: '#ffffff' }
    })
  })

  it('undo keeps what the user changed after the delete', () => {
    const { updates, undo } = terminalCustomThemeRemoval(settings, 'warp:dusk')
    const afterDelete = { ...settings, ...updates, terminalCustomThemes: [kept] }
    const restored = undo({
      ...afterDelete,
      terminalThemeDark: 'Tokyo Night',
      terminalColorOverridesLight: { cursor: '#ff00ff' }
    })
    expect(restored).toEqual({ terminalCustomThemes: [kept, imported] })
    const reimported = { ...imported, name: 'Dusk v2' }
    expect(undo({ ...afterDelete, terminalCustomThemes: [kept, reimported] })).not.toHaveProperty(
      'terminalCustomThemes'
    )
  })

  it('leaves slots showing another theme untouched', () => {
    const { updates } = terminalCustomThemeRemoval(
      { ...settings, terminalThemeLight: 'custom:warp:dawn' },
      'warp:dusk'
    )
    expect(updates).not.toHaveProperty('terminalThemeLight')
    expect(updates).not.toHaveProperty('terminalColorOverridesLight')
  })
})
