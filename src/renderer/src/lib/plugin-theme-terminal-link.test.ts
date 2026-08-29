import { describe, expect, it } from 'vitest'
import type { PluginThemeRegistration } from '../../../shared/plugins/plugin-theme-artifact'
import { getPluginThemeSettingsUpdate } from './plugin-theme-terminal-link'

const settings = {
  theme: 'dark' as const,
  pluginAppTheme: null,
  terminalThemeDark: 'Ghostty Default Style Dark',
  terminalThemeLight: 'Builtin Tango Light',
  terminalUseSeparateLightTheme: false
}

function theme(
  base: 'light' | 'dark',
  terminalThemeId?: `plugin:${string}`
): PluginThemeRegistration {
  return {
    schemaVersion: 5,
    id: `plugin:stablyai.appearance/${base}`,
    pluginKey: 'stablyai.appearance',
    contributionId: base,
    label: base,
    base,
    tokens: { '--background': base === 'light' ? '#ece7dc' : '#262626' },
    terminalThemeId
  }
}

describe('plugin appearance terminal links', () => {
  it('selects the light terminal through existing terminal settings', () => {
    expect(
      getPluginThemeSettingsUpdate(
        theme('light', 'plugin:stablyai.appearance/paper-terminal'),
        settings
      )
    ).toEqual({
      theme: 'light',
      terminalUseSeparateLightTheme: true,
      terminalThemeLight: 'plugin:stablyai.appearance/paper-terminal'
    })
  })

  it('selects the dark terminal without changing the light preference', () => {
    expect(
      getPluginThemeSettingsUpdate(
        theme('dark', 'plugin:stablyai.appearance/stage-terminal'),
        settings
      )
    ).toEqual({ terminalThemeDark: 'plugin:stablyai.appearance/stage-terminal' })
  })

  it('is idempotent after the linked settings are active', () => {
    expect(
      getPluginThemeSettingsUpdate(theme('light', 'plugin:stablyai.appearance/paper-terminal'), {
        ...settings,
        pluginAppTheme: 'plugin:stablyai.appearance/light',
        theme: 'light',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'plugin:stablyai.appearance/paper-terminal'
      })
    ).toBeNull()
  })

  it('preserves a terminal theme selected after the appearance plugin', () => {
    expect(
      getPluginThemeSettingsUpdate(theme('light', 'plugin:stablyai.appearance/paper-terminal'), {
        ...settings,
        pluginAppTheme: 'plugin:stablyai.appearance/light',
        theme: 'light',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'Builtin Tango Light'
      })
    ).toBeNull()
  })
})
