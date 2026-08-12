import { describe, expect, it } from 'vitest'
import {
  EDITOR_COLOR_THEME_VALUES,
  getAvailableEditorColorThemeOptions,
  resolveMonacoThemeName
} from './editor-theme'

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
  it('exposes auto/vs/vs-dark plus every catalog theme exactly once', () => {
    expect(EDITOR_COLOR_THEME_VALUES).toEqual([
      'auto',
      'vs',
      'vs-dark',
      'monokai',
      'dracula',
      'one-dark',
      'solarized-dark',
      'solarized-light'
    ])
    expect(new Set(EDITOR_COLOR_THEME_VALUES).size).toBe(EDITOR_COLOR_THEME_VALUES.length)
  })
})

describe('getAvailableEditorColorThemeOptions', () => {
  it('returns one option per EDITOR_COLOR_THEME_VALUES entry, in the same order', () => {
    const options = getAvailableEditorColorThemeOptions()
    expect(options.map((option) => option.value)).toEqual([...EDITOR_COLOR_THEME_VALUES])
  })

  it('gives every option a non-empty label', () => {
    for (const option of getAvailableEditorColorThemeOptions()) {
      expect(option.label.length, option.value).toBeGreaterThan(0)
    }
  })

  it('gives every non-auto option a 5-color swatch', () => {
    for (const option of getAvailableEditorColorThemeOptions()) {
      if (option.value === 'auto') {
        expect(option.swatch).toBeUndefined()
      } else {
        expect(option.swatch, option.value).toHaveLength(5)
      }
    }
  })
})
