import { describe, expect, it } from 'vitest'
import {
  resolveRuntimeMobileTerminalTheme,
  type RuntimeMobileTerminalThemeSettings
} from './runtime-mobile-terminal-theme'

describe('resolveRuntimeMobileTerminalTheme', () => {
  it('returns undefined without settings', () => {
    expect(resolveRuntimeMobileTerminalTheme(undefined, true)).toBeUndefined()
    expect(resolveRuntimeMobileTerminalTheme(null, true)).toBeUndefined()
  })

  it('projects the dark slot with mode dark', () => {
    expect(
      resolveRuntimeMobileTerminalTheme({ theme: 'dark', terminalThemeDark: 'Tokyo Night' }, true)
    ).toMatchObject({ mode: 'dark', theme: { background: '#1a1b26', foreground: '#c0caf5' } })
  })

  it('follows systemPrefersDark only when theme is system', () => {
    const settings: RuntimeMobileTerminalThemeSettings = { theme: 'system' }
    expect(resolveRuntimeMobileTerminalTheme(settings, true)?.mode).toBe('dark')
    expect(resolveRuntimeMobileTerminalTheme(settings, false)?.mode).toBe('light')
    expect(resolveRuntimeMobileTerminalTheme({ theme: 'light' }, true)?.mode).toBe('light')
    expect(resolveRuntimeMobileTerminalTheme({ theme: 'dark' }, false)?.mode).toBe('dark')
  })

  it('takes the light built-in when terminalUseSeparateLightTheme is absent', () => {
    // Absent must read as the shipped `true` default, not as false.
    expect(resolveRuntimeMobileTerminalTheme({ theme: 'light' }, false)?.theme.background).toBe(
      '#ffffff'
    )
    expect(
      resolveRuntimeMobileTerminalTheme(
        { theme: 'light', terminalUseSeparateLightTheme: false, terminalThemeDark: 'Tokyo Night' },
        false
      )
    ).toMatchObject({ mode: 'light', theme: { background: '#1a1b26' } })
  })

  it('spreads terminalColorOverrides and converts opacities to rgba', () => {
    expect(
      resolveRuntimeMobileTerminalTheme(
        {
          theme: 'light',
          terminalUseSeparateLightTheme: true,
          terminalColorOverrides: {
            background: '#f8f8f8',
            foreground: '#101010',
            cursor: '#202020'
          },
          terminalBackgroundOpacity: 0.8,
          terminalCursorOpacity: 0.5
        },
        true
      )
    ).toMatchObject({
      mode: 'light',
      theme: {
        background: 'rgba(248, 248, 248, 0.8)',
        foreground: '#101010',
        cursor: 'rgba(32, 32, 32, 0.5)'
      }
    })
  })

  it('expands 3-digit hex overrides before applying opacity', () => {
    expect(
      resolveRuntimeMobileTerminalTheme(
        {
          theme: 'dark',
          terminalColorOverrides: { background: '#abc' },
          terminalBackgroundOpacity: 0.25
        },
        true
      )?.theme.background
    ).toBe('rgba(170, 187, 204, 0.25)')
  })

  it('leaves a non-hex background untouched and drops non-string values', () => {
    const projected = resolveRuntimeMobileTerminalTheme(
      {
        theme: 'dark',
        terminalColorOverrides: {
          background: 'rgb(1, 2, 3)',
          // Why: the wire shape is string-only; a stray array must not reach the phone.
          foreground: ['#fff'] as unknown as string
        },
        terminalBackgroundOpacity: 0.4
      },
      true
    )
    expect(projected?.theme.background).toBe('rgb(1, 2, 3)')
    expect(projected?.theme).not.toHaveProperty('foreground')
  })

  it('falls back to the dark built-in when the configured theme name is unknown', () => {
    expect(
      resolveRuntimeMobileTerminalTheme({ theme: 'dark', terminalThemeDark: 'Nope' }, true)?.theme
        .background
    ).toBe('#282c34')
  })
})
