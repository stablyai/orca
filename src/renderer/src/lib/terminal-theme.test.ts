import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getTerminalThemePreview,
  resolveEffectiveTerminalAppearance
} from './terminal-theme'

describe('resolveEffectiveTerminalAppearance', () => {
  it('uses the light terminal theme for system theme on light OS when light variant is enabled', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'system',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.mode).toBe('light')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_LIGHT)
  })

  it('uses the dark terminal theme for system theme on dark OS', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'system',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8'
      },
      true
    )

    expect(appearance.mode).toBe('dark')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_DARK)
  })

  it('reuses the dark terminal theme in light mode when separate light theme is disabled', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: false,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.mode).toBe('light')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_DARK)
  })

  it('falls back to the default light theme when terminalThemeLight is blank', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: '',
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_LIGHT)
  })

  it('keeps invalid terminalThemeLight names while preview falls back to dark', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'Invalid Theme Name',
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.themeName).toBe('Invalid Theme Name')
    expect(appearance.theme).toEqual(getTerminalThemePreview(DEFAULT_TERMINAL_THEME_DARK))
  })
})
