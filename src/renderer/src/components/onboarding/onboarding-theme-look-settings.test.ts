import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { MATCH_TERMINAL_APP_THEME } from '../../../../shared/plugin-theme-settings'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { PluginThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-theme-artifact'
import type { PluginTerminalThemeRegistration } from '../../../../shared/plugins/artifacts/plugin-terminal-theme-artifact'
import { buildThemeLooks, type ThemeLook, type ThemeLookBase } from './onboarding-theme-looks'
import { selectedThemeLookId, themeLookSettingsUpdate } from './onboarding-theme-look-settings'

const labels = { orca: 'Orca', community: 'Terminal palette', builtIn: (b: ThemeLookBase) => b }
const appTheme: PluginThemeRegistration = {
  id: 'plugin:gh/github-dark-default',
  base: 'dark',
  tokens: { '--background': '#0d1117', '--foreground': '#e6edf3' },
  revision: '1',
  pluginKey: 'gh',
  pluginName: 'GitHub Themes',
  label: 'GitHub Dark Default'
}
const terminalTheme: PluginTerminalThemeRegistration = {
  id: 'plugin:gh/github-dark-default',
  pluginKey: 'gh',
  pluginName: 'GitHub Themes',
  label: 'GitHub Dark Default',
  mode: 'dark',
  terminal: { background: '#010409', foreground: '#e6edf3', red: '#ff7b72' }
}

function setup(overrides: Partial<GlobalSettings> = {}) {
  const settings: GlobalSettings = { ...getDefaultSettings('/home/test'), ...overrides }
  const looks = (base: ThemeLookBase): ThemeLook[] =>
    buildThemeLooks({
      base,
      pluginThemes: [appTheme],
      pluginTerminalThemes: [terminalTheme],
      baseline: settings,
      labels
    })
  const look = (base: ThemeLookBase, id: string): ThemeLook =>
    looks(base).find((candidate) => candidate.id === id)!
  const pick = (current: GlobalSettings, chosen: ThemeLook): GlobalSettings => ({
    ...current,
    ...themeLookSettingsUpdate(chosen, current, settings, [terminalTheme])
  })
  return { settings, looks, look, pick }
}

describe('themeLookSettingsUpdate', () => {
  it('paints a terminal palette app-wide and drops overrides that would mask it', () => {
    const { settings, look, looks, pick } = setup({
      terminalColorOverrides: { background: '#123456' }
    })
    const next = pick(settings, look('dark', 'terminal:Dracula'))

    expect(next.pluginAppThemeDark).toBe(MATCH_TERMINAL_APP_THEME)
    expect(next.terminalThemeDark).toBe('Dracula')
    expect(next.terminalColorOverrides).toBeUndefined()
    expect(selectedThemeLookId(next, 'dark', looks('dark'))).toBe('terminal:Dracula')
  })

  it('replaces an earlier pick in the same mode with the baseline before applying', () => {
    const { settings, look, looks, pick } = setup()
    const afterPalette = pick(settings, look('dark', 'terminal:Dracula'))
    const next = pick(afterPalette, look('dark', appTheme.id))

    expect(next.pluginAppThemeDark).toBe(appTheme.id)
    // The plugin's own terminal palette replaces Dracula rather than layering on it.
    expect(next.terminalThemeDark).not.toBe('Dracula')
    expect(selectedThemeLookId(next, 'dark', looks('dark'))).toBe(appTheme.id)

    const reset = pick(next, look('dark', 'built-in:dark'))
    expect(reset.pluginAppThemeDark).toBeNull()
    expect(reset.terminalThemeDark).toBe(settings.terminalThemeDark)
  })

  it('leaves the other mode untouched and keeps light palettes off the dark terminal', () => {
    const { settings, look, pick } = setup({ terminalUseSeparateLightTheme: false })
    const dark = pick(settings, look('dark', 'terminal:Dracula'))
    const next = pick(dark, look('light', 'terminal:Catppuccin Latte'))

    expect(next.pluginAppThemeDark).toBe(MATCH_TERMINAL_APP_THEME)
    expect(next.terminalThemeDark).toBe('Dracula')
    expect(next.terminalThemeLight).toBe('Catppuccin Latte')
    expect(next.terminalUseSeparateLightTheme).toBe(true)
  })
})
