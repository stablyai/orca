import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getAvailableTerminalThemeOptions,
  getBuiltinTheme,
  getTerminalThemePreview,
  isTerminalBackgroundLight,
  resolveEffectiveTerminalAppearance
} from './terminal-theme'

// Mirrors Codex instruction block gray so the dark selection cannot disappear into it.
const INSTRUCTION_BLOCK_BACKGROUND = '#3e4451'

function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  const hex = match?.[1]
  if (!hex) {
    return null
  }

  const value = Number.parseInt(hex, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toLinearChannel(channel: number): number {
  const scaled = channel / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  return (
    0.2126 * toLinearChannel(red) + 0.7152 * toLinearChannel(green) + 0.0722 * toLinearChannel(blue)
  )
}

function contrastRatio(first: string, second: string): number {
  const firstRgb = parseHexColor(first)
  const secondRgb = parseHexColor(second)

  expect(firstRgb, `${first} should be a 6-digit hex color`).not.toBeNull()
  expect(secondRgb, `${second} should be a 6-digit hex color`).not.toBeNull()
  if (!firstRgb || !secondRgb) {
    throw new Error('Expected contrast colors to parse as 6-digit hex values')
  }

  const firstLuminance = relativeLuminance(firstRgb)
  const secondLuminance = relativeLuminance(secondRgb)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)

  return (lighter + 0.05) / (darker + 0.05)
}

afterEach(() => {
  vi.restoreAllMocks()
})

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

describe('default dark terminal theme selection contrast', () => {
  it('keeps selection distinct from instruction blocks while preserving readable selected text', () => {
    const theme = getBuiltinTheme(DEFAULT_TERMINAL_THEME_DARK)

    expect(theme, `${DEFAULT_TERMINAL_THEME_DARK} should exist`).not.toBeNull()

    const selectionBackground = theme?.selectionBackground
    const selectionForeground = theme?.selectionForeground

    expect(selectionBackground, 'selectionBackground should be defined').toBeDefined()
    expect(selectionForeground, 'selectionForeground should be defined').toBeDefined()
    if (!selectionBackground || !selectionForeground) {
      throw new Error(`${DEFAULT_TERMINAL_THEME_DARK} is missing selection colors`)
    }

    expect(contrastRatio(selectionBackground, INSTRUCTION_BLOCK_BACKGROUND)).toBeGreaterThanOrEqual(
      2
    )
    expect(contrastRatio(selectionForeground, selectionBackground)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('isTerminalBackgroundLight', () => {
  it('classifies common terminal background color formats by luminance', () => {
    const split = vi.spyOn(String.prototype, 'split')

    expect(isTerminalBackgroundLight('#ffffff')).toBe(true)
    expect(isTerminalBackgroundLight('#18181b')).toBe(false)
    expect(isTerminalBackgroundLight('#fffc')).toBe(true)
    expect(isTerminalBackgroundLight('rgb(245 245 244)')).toBe(true)
    expect(isTerminalBackgroundLight('rgba(24, 24, 27, 0.92)')).toBe(false)
    expect(
      split.mock.calls.filter(
        ([separator]) => separator instanceof RegExp && separator.source === '\\s+'
      )
    ).toHaveLength(0)
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
