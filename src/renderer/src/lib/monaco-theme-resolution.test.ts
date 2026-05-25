import { describe, expect, it } from 'vitest'
import { resolveMonacoThemeName } from './monaco-theme-resolution'
import { ORCA_GLASS_DARK_THEME_NAME, ORCA_GLASS_LIGHT_THEME_NAME } from './monaco-glass-themes'

describe('resolveMonacoThemeName', () => {
  it('maps glass-dark to the orca-glass-dark Monaco theme', () => {
    expect(resolveMonacoThemeName('glass-dark', true)).toBe(ORCA_GLASS_DARK_THEME_NAME)
    expect(resolveMonacoThemeName('glass-dark', false)).toBe(ORCA_GLASS_DARK_THEME_NAME)
  })

  it('maps glass-light to the orca-glass-light Monaco theme', () => {
    expect(resolveMonacoThemeName('glass-light', true)).toBe(ORCA_GLASS_LIGHT_THEME_NAME)
    expect(resolveMonacoThemeName('glass-light', false)).toBe(ORCA_GLASS_LIGHT_THEME_NAME)
  })

  it('falls back to vs-dark when theme is dark', () => {
    expect(resolveMonacoThemeName('dark', true)).toBe('vs-dark')
  })

  it('falls back to vs when theme is light', () => {
    expect(resolveMonacoThemeName('light', false)).toBe('vs')
  })

  it('falls back to isDark mapping for system theme', () => {
    expect(resolveMonacoThemeName('system', true)).toBe('vs-dark')
    expect(resolveMonacoThemeName('system', false)).toBe('vs')
  })

  it('falls back to isDark mapping for undefined theme', () => {
    expect(resolveMonacoThemeName(undefined, true)).toBe('vs-dark')
    expect(resolveMonacoThemeName(undefined, false)).toBe('vs')
  })

  it('glass-* takes precedence over isDark', () => {
    // Why: even if isDark is "wrong" for the glass variant (e.g. caller
    // forgot to update isDark when theme is glass-light), the glass branch
    // wins — guarantees the registered theme name lands consistently.
    expect(resolveMonacoThemeName('glass-light', true)).toBe(ORCA_GLASS_LIGHT_THEME_NAME)
    expect(resolveMonacoThemeName('glass-dark', false)).toBe(ORCA_GLASS_DARK_THEME_NAME)
  })
})
