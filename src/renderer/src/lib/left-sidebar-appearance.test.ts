import { describe, expect, it } from 'vitest'
import { resolveLeftSidebarStyleVariables } from './left-sidebar-appearance'

function tintedSettings(
  opacity: number
): NonNullable<Parameters<typeof resolveLeftSidebarStyleVariables>[0]> {
  return {
    theme: 'dark',
    leftSidebarAppearanceMode: 'tinted',
    leftSidebarTintColor: '#18181b',
    leftSidebarTintOpacity: opacity,
    terminalThemeDark: 'default',
    terminalThemeLight: 'default',
    terminalDividerColorDark: '#3f3f46',
    terminalDividerColorLight: '#d4d4d8',
    terminalUseSeparateLightTheme: true,
    terminalCustomThemes: [],
    terminalColorOverrides: {},
    terminalBackgroundOpacity: 1
  }
}

describe('left sidebar theme selection tokens', () => {
  it('preserves theme tokens when a saved custom tint is zero', () => {
    for (const systemPrefersDark of [true, false]) {
      expect(resolveLeftSidebarStyleVariables(tintedSettings(0), systemPrefersDark)).toBeUndefined()
    }
  })

  it('still applies a nonzero custom tint', () => {
    expect(
      resolveLeftSidebarStyleVariables(tintedSettings(0.2), true)?.['--worktree-sidebar']
    ).toContain('20%')
  })
})
