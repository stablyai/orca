import { describe, expect, it } from 'vitest'
import { resolveMonacoThemeName } from './monaco-theme-resolution'
import { ORCA_GLASS_DARK_THEME_NAME, ORCA_GLASS_LIGHT_THEME_NAME } from './monaco-glass-themes'

describe('resolveMonacoThemeName', () => {
  it('returns vs-dark when glass off + isDark true', () => {
    expect(resolveMonacoThemeName({ glassEffect: false }, true)).toBe('vs-dark')
  })

  it('returns vs when glass off + isDark false', () => {
    expect(resolveMonacoThemeName({ glassEffect: false }, false)).toBe('vs')
  })

  it('returns orca-glass-dark when glass on + isDark true on macOS', () => {
    expect(resolveMonacoThemeName({ glassEffect: true }, true, { isDarwin: true })).toBe(
      ORCA_GLASS_DARK_THEME_NAME
    )
  })

  it('returns orca-glass-light when glass on + isDark false on macOS', () => {
    expect(resolveMonacoThemeName({ glassEffect: true }, false, { isDarwin: true })).toBe(
      ORCA_GLASS_LIGHT_THEME_NAME
    )
  })

  it('ignores persisted glassEffect on non-macOS hosts', () => {
    expect(resolveMonacoThemeName({ glassEffect: true }, true, { isDarwin: false })).toBe('vs-dark')
    expect(resolveMonacoThemeName({ glassEffect: true }, false, { isDarwin: false })).toBe('vs')
  })

  it('treats null / undefined settings as glass-off', () => {
    expect(resolveMonacoThemeName(null, true)).toBe('vs-dark')
    expect(resolveMonacoThemeName(undefined, false)).toBe('vs')
  })
})
