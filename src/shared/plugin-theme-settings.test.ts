import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from './global-settings-types'
import {
  hasLegacyMatchTerminalSidebar,
  legacyMatchTerminalSidebarWrite,
  syncLegacyMatchTerminalSidebar,
  normalizePluginThemeSettings,
  pluginThemeSettingsAfterRemoval
} from './plugin-theme-settings'

const colors = { background: '#1b1430', foreground: '#e8e0ff', red: '#ff6b8b' }

describe('plugin theme settings', () => {
  it('bounds what a client may write', () => {
    expect(
      normalizePluginThemeSettings({
        pluginAppTheme: 'plugin:samples.dusk/dusk',
        themeBeforePlugin: 'system',
        terminalPluginPalettes: [
          { id: 'plugin:samples.dusk/dusk', colors },
          { id: 'plugin:samples.dusk/dusk', colors },
          { id: 'not-a-plugin', colors },
          { id: 'plugin:samples.other/a', colors: { background: 'red;' } },
          { id: 'plugin:samples.b/b', colors },
          { id: 'plugin:samples.c/c', colors }
        ]
      })
    ).toEqual({
      pluginAppTheme: 'plugin:samples.dusk/dusk',
      themeBeforePlugin: 'system',
      terminalPluginPalettes: [
        { id: 'plugin:samples.dusk/dusk', colors },
        { id: 'plugin:samples.b/b', colors }
      ]
    })
    expect(
      normalizePluginThemeSettings({
        pluginAppTheme: 'plugin:../x',
        pluginAppThemeLight: 'plugin:samples.dawn/dawn',
        pluginAppThemeDark: 'match-terminal',
        pluginIconTheme: 'x'.repeat(10_000),
        themeBeforePlugin: 'neon',
        editorThemeLight: 'dark',
        editorThemeDark: 'vs-dark'
      })
    ).toEqual({
      pluginAppTheme: null,
      pluginAppThemeLight: 'plugin:samples.dawn/dawn',
      pluginAppThemeDark: 'match-terminal',
      editorThemeLight: 'dark',
      editorThemeDark: null,
      pluginIconTheme: null,
      themeBeforePlugin: null
    })
    const unrelated: Partial<GlobalSettings> = { editorAutoSave: true }
    expect(normalizePluginThemeSettings(unrelated)).toEqual({})
  })

  it('forgets an uninstalled plugin and restores the earlier Theme choice', () => {
    expect(
      pluginThemeSettingsAfterRemoval(
        {
          theme: 'dark',
          themeBeforePlugin: 'system',
          pluginAppTheme: 'plugin:samples.dusk/dusk',
          pluginIconTheme: 'plugin:samples.dusk/icons',
          terminalThemeDark: 'plugin:samples.dusk/dusk',
          terminalThemeLight: 'Builtin Tango Light',
          terminalPluginPalettes: [{ id: 'plugin:samples.dusk/dusk', colors }]
        },
        'samples.dusk'
      )
    ).toEqual({
      pluginAppTheme: null,
      themeBeforePlugin: null,
      theme: 'system',
      pluginIconTheme: null,
      terminalThemeDark: '',
      terminalPluginPalettes: []
    })
    expect(
      pluginThemeSettingsAfterRemoval(
        {
          theme: 'light',
          pluginAppTheme: 'plugin:samples.dusk-two/dusk',
          terminalThemeDark: '',
          terminalThemeLight: ''
        },
        'samples.dusk'
      )
    ).toEqual({})
  })

  it("clears only the removed plugin's light or dark slot", () => {
    expect(
      pluginThemeSettingsAfterRemoval(
        {
          theme: 'system',
          pluginAppThemeLight: 'plugin:other.dawn/dawn',
          pluginAppThemeDark: 'plugin:samples.dusk/dusk',
          editorThemeLight: 'plugin:samples.dusk/dusk',
          editorThemeDark: 'light',
          terminalThemeDark: '',
          terminalThemeLight: ''
        },
        'samples.dusk'
      )
    ).toEqual({ pluginAppThemeDark: null, editorThemeLight: null })
  })

  it('moves the legacy Match Terminal sidebar into the empty app theme slots', () => {
    const legacy = {
      leftSidebarAppearanceMode: 'match-terminal' as const,
      pluginAppThemeLight: null,
      pluginAppThemeDark: 'plugin:samples.dusk/dusk' as const
    }
    expect(hasLegacyMatchTerminalSidebar(legacy)).toBe(true)
    expect(syncLegacyMatchTerminalSidebar(legacy, true)).toEqual({
      leftSidebarAppearanceMode: 'match-terminal',
      pluginAppThemeLight: 'match-terminal',
      pluginAppThemeDark: 'plugin:samples.dusk/dusk'
    })
  })

  it('keeps the sidebar value in step with the slots so older Orca still matches the terminal', () => {
    const current = {
      leftSidebarAppearanceMode: 'match-terminal' as const,
      pluginAppThemeLight: 'match-terminal' as const,
      pluginAppThemeDark: 'match-terminal' as const
    }
    // Choosing Built-in for one mode keeps the mirror; for both, it clears it without refilling.
    expect(legacyMatchTerminalSidebarWrite(current, { pluginAppThemeLight: null })).toMatchObject({
      leftSidebarAppearanceMode: 'match-terminal',
      pluginAppThemeLight: null
    })
    const builtIn = legacyMatchTerminalSidebarWrite(current, {
      pluginAppThemeLight: null,
      pluginAppThemeDark: null
    })
    expect(builtIn.leftSidebarAppearanceMode).toBe('default')
    expect(hasLegacyMatchTerminalSidebar({ ...current, ...builtIn })).toBe(false)
    // A full-settings write keeps the mirror beside the cleared slots; that is not legacy intent.
    expect(
      legacyMatchTerminalSidebarWrite(current, {
        ...current,
        pluginAppThemeLight: null,
        pluginAppThemeDark: null
      })
    ).toMatchObject({
      pluginAppThemeLight: null,
      pluginAppThemeDark: null,
      leftSidebarAppearanceMode: 'default'
    })
    expect(
      legacyMatchTerminalSidebarWrite(
        { ...current, pluginAppThemeLight: null, pluginAppThemeDark: null },
        { leftSidebarAppearanceMode: 'match-terminal' }
      )
    ).toMatchObject({ pluginAppThemeLight: 'match-terminal', pluginAppThemeDark: 'match-terminal' })
    expect(
      legacyMatchTerminalSidebarWrite(current, { leftSidebarAppearanceMode: 'tinted' })
    ).toMatchObject({
      leftSidebarAppearanceMode: 'tinted'
    })
    expect(legacyMatchTerminalSidebarWrite(current, { editorAutoSave: true })).toEqual({})
  })
})
