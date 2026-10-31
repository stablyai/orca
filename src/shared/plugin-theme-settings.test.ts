import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from './global-settings-types'
import {
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
        pluginAppThemeDark: 42,
        pluginIconTheme: 'x'.repeat(10_000),
        themeBeforePlugin: 'neon'
      })
    ).toEqual({
      pluginAppTheme: null,
      pluginAppThemeLight: 'plugin:samples.dawn/dawn',
      pluginAppThemeDark: null,
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
          terminalThemeDark: '',
          terminalThemeLight: ''
        },
        'samples.dusk'
      )
    ).toEqual({ pluginAppThemeDark: null })
  })
})
