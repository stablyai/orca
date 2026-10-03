import { describe, expect, it } from 'vitest'
import { selectTerminalTheme } from './terminal-theme-selection'

const base = {
  theme: 'system' as const,
  terminalThemeDark: 'Ghostty Default Style Dark',
  terminalUseSeparateLightTheme: true,
  terminalThemeLight: 'Builtin Tango Light'
}

describe('the terminal theme a host selects', () => {
  it('keeps using the dark theme in light mode when no separate light theme is set', () => {
    expect(
      selectTerminalTheme({ ...base, theme: 'light', terminalUseSeparateLightTheme: false }, true)
    ).toEqual({ mode: 'light', useLightVariant: false, themeName: 'Ghostty Default Style Dark' })
  })
})
