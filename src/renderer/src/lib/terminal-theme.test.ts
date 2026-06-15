import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getAvailableTerminalThemeOptions,
  getTerminalThemePreview,
  isTerminalBackgroundLight,
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

  it('keeps invalid terminalThemeLight names while preview falls back to light', () => {
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
    expect(appearance.theme).toEqual(getTerminalThemePreview(DEFAULT_TERMINAL_THEME_LIGHT))
  })

  it('resolves custom theme selections by id', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'dark',
        terminalThemeDark: 'custom:warp:tokyo-night',
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8',
        terminalCustomThemes: [
          {
            id: 'warp:tokyo-night',
            name: 'Builtin Tango Light',
            source: 'warp',
            mode: 'dark',
            terminal: {
              background: '#1a1b26',
              foreground: '#c0caf5',
              black: '#15161e'
            },
            importedAt: '2026-06-05T00:00:00.000Z'
          }
        ]
      },
      true
    )

    expect(appearance.themeName).toBe('custom:warp:tokyo-night')
    expect(appearance.theme?.background).toBe('#1a1b26')
  })

  it('falls back visually when a custom selection is missing', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'dark',
        terminalThemeDark: 'custom:warp:missing',
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8',
        terminalCustomThemes: []
      },
      true
    )

    expect(appearance.themeName).toBe('custom:warp:missing')
    expect(appearance.theme).toEqual(getTerminalThemePreview(DEFAULT_TERMINAL_THEME_DARK))
  })

  it('falls back visually to the light default when a light custom selection is missing', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'custom:warp:missing',
        terminalDividerColorLight: '#d4d4d8',
        terminalCustomThemes: []
      },
      false
    )

    expect(appearance.themeName).toBe('custom:warp:missing')
    expect(appearance.theme).toEqual(getTerminalThemePreview(DEFAULT_TERMINAL_THEME_LIGHT))
  })

  it('includes imported themes as grouped picker options', () => {
    const options = getAvailableTerminalThemeOptions({
      terminalCustomThemes: [
        {
          id: 'warp:tokyo-night',
          name: 'Tokyo Night',
          source: 'warp',
          mode: 'dark',
          terminal: {
            background: '#1a1b26',
            foreground: '#c0caf5',
            black: '#15161e'
          },
          importedAt: '2026-06-05T00:00:00.000Z'
        }
      ]
    })

    expect(options.some((option) => option.group === 'built-in')).toBe(true)
    expect(options).toContainEqual(
      expect.objectContaining({
        value: 'custom:warp:tokyo-night',
        label: 'Tokyo Night',
        group: 'imported',
        sourceLabel: 'Warp'
      })
    )
  })
})

describe('isTerminalBackgroundLight', () => {
  it('classifies common terminal background color formats by luminance', () => {
    expect(isTerminalBackgroundLight('#ffffff')).toBe(true)
    expect(isTerminalBackgroundLight('#18181b')).toBe(false)
    expect(isTerminalBackgroundLight('#fffc')).toBe(true)
    expect(isTerminalBackgroundLight('rgb(245 245 244)')).toBe(true)
    expect(isTerminalBackgroundLight('rgba(24, 24, 27, 0.92)')).toBe(false)
  })

  it('classifies transparent backgrounds after compositing with the app surface', () => {
    expect(
      isTerminalBackgroundLight('#ffffff', { backgroundOpacity: 0.1, appSurface: 'dark' })
    ).toBe(false)
    expect(
      isTerminalBackgroundLight('#ffffff', { backgroundOpacity: 0.6, appSurface: 'dark' })
    ).toBe(true)
    expect(isTerminalBackgroundLight('rgba(255, 255, 255, 0.1)', { appSurface: 'dark' })).toBe(
      false
    )
    expect(isTerminalBackgroundLight('rgb(255 255 255 / 10%)', { appSurface: 'dark' })).toBe(false)
    expect(
      isTerminalBackgroundLight('#000000', { backgroundOpacity: 0.1, appSurface: 'light' })
    ).toBe(true)
  })

  it('defaults unknown colors to dark-surface title styling', () => {
    expect(isTerminalBackgroundLight(undefined)).toBe(false)
    expect(isTerminalBackgroundLight('var(--background)')).toBe(false)
  })
})
