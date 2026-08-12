import { describe, expect, it } from 'vitest'
import { EDITOR_COLOR_THEME_VALUES, resolveMonacoThemeName } from './editor-theme'

describe('resolveMonacoThemeName', () => {
  it('follows isDark when the preference is undefined (profiles saved before the setting existed)', () => {
    expect(resolveMonacoThemeName(undefined, true)).toBe('vs-dark')
    expect(resolveMonacoThemeName(undefined, false)).toBe('vs')
  })

  it('follows isDark when the preference is explicitly "auto"', () => {
    expect(resolveMonacoThemeName('auto', true)).toBe('vs-dark')
    expect(resolveMonacoThemeName('auto', false)).toBe('vs')
  })

  it('overrides isDark when an explicit theme is selected', () => {
    expect(resolveMonacoThemeName('monokai', false)).toBe('monokai')
    expect(resolveMonacoThemeName('monokai', true)).toBe('monokai')
  })

  it('still respects an explicit light/dark override regardless of isDark', () => {
    expect(resolveMonacoThemeName('vs', true)).toBe('vs')
    expect(resolveMonacoThemeName('vs-dark', false)).toBe('vs-dark')
  })
})

describe('EDITOR_COLOR_THEME_VALUES', () => {
  it('exposes auto plus every explicit Monaco theme choice exactly once', () => {
    expect(EDITOR_COLOR_THEME_VALUES).toEqual(['auto', 'vs', 'vs-dark', 'monokai'])
    expect(new Set(EDITOR_COLOR_THEME_VALUES).size).toBe(EDITOR_COLOR_THEME_VALUES.length)
  })
})
