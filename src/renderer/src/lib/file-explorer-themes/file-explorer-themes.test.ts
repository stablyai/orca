import { describe, expect, it } from 'vitest'
import {
  FILE_EXPLORER_COLOR_KEYS,
  FILE_EXPLORER_COLOR_THEME_CATALOG,
  getFileExplorerColorTheme,
  getFileExplorerColorThemeNames,
  toColorMap
} from './index'

describe('file-explorer color themes', () => {
  it('ships at least one dark and one light built-in', () => {
    const themes = getFileExplorerColorThemeNames()
    expect(themes.some((t) => t.mode === 'dark')).toBe(true)
    expect(themes.some((t) => t.mode === 'light')).toBe(true)
  })

  it.each(Object.values(FILE_EXPLORER_COLOR_THEME_CATALOG))(
    'theme "$id" supplies every required color key',
    (theme) => {
      const map = toColorMap(theme) as Record<string, string>
      for (const key of FILE_EXPLORER_COLOR_KEYS) {
        expect(map[key], `missing key "${key}" on theme "${theme.id}"`).toBeTypeOf('string')
        expect(map[key].length).toBeGreaterThan(0)
      }
    }
  )

  it('resolves an existing theme by id', () => {
    expect(getFileExplorerColorTheme('default-dark')?.id).toBe('default-dark')
    expect(getFileExplorerColorTheme('default-light')?.id).toBe('default-light')
  })

  it('returns undefined for unknown ids', () => {
    expect(getFileExplorerColorTheme('not-a-theme')).toBeUndefined()
  })

  it('mode filter narrows the catalog', () => {
    const darks = getFileExplorerColorThemeNames('dark')
    expect(darks.every((t) => t.mode === 'dark')).toBe(true)
    const lights = getFileExplorerColorThemeNames('light')
    expect(lights.every((t) => t.mode === 'light')).toBe(true)
  })

  it('has unique ids across the catalog', () => {
    const ids = Object.values(FILE_EXPLORER_COLOR_THEME_CATALOG).map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
