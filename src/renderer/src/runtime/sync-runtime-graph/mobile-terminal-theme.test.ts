import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { resolveMobileTerminalTheme } from './mobile-terminal-theme'

function stateWith(settings: Record<string, unknown> | null): AppState {
  return { settings } as unknown as AppState
}

const BASE = {
  terminalThemeDark: 'Ghostty Default Style Dark',
  terminalThemeLight: 'Builtin Tango Light',
  terminalUseSeparateLightTheme: true,
  theme: 'dark'
}

// Explicit contrast floor must travel with theme or mobile renders the same session differently (#10754).
describe('resolveMobileTerminalTheme contrast floor', () => {
  it('omits the floor when the user has not set one', () => {
    const theme = resolveMobileTerminalTheme(stateWith(BASE), true)
    expect(theme?.minimumContrastRatio).toBeUndefined()
  })

  it('publishes the user floor so the phone stops lifting low-contrast output', () => {
    const theme = resolveMobileTerminalTheme(
      stateWith({ ...BASE, terminalMinimumContrastRatio: 1 }),
      true
    )
    expect(theme?.minimumContrastRatio).toBe(1)
  })

  it('clamps before publishing so an old client can trust the value', () => {
    expect(
      resolveMobileTerminalTheme(stateWith({ ...BASE, terminalMinimumContrastRatio: 99 }), true)
        ?.minimumContrastRatio
    ).toBe(21)
    expect(
      resolveMobileTerminalTheme(
        stateWith({ ...BASE, terminalMinimumContrastRatio: Number.NaN }),
        true
      )?.minimumContrastRatio
    ).toBeUndefined()
  })

  it('returns nothing without settings', () => {
    expect(resolveMobileTerminalTheme(stateWith(null), true)).toBeUndefined()
  })
})
