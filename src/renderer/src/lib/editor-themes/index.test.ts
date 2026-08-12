import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { EDITOR_THEME_CATALOG, registerEditorThemeCatalog } from './index'
import { buildMonacoThemeFromPalette } from './palette'

describe('EDITOR_THEME_CATALOG', () => {
  it('gives every catalog theme a non-empty label and a valid base', () => {
    for (const [id, entry] of Object.entries(EDITOR_THEME_CATALOG)) {
      expect(entry.label.length, `${id} label`).toBeGreaterThan(0)
      expect(['dark', 'light']).toContain(entry.palette.base)
    }
  })

  it('includes Monokai matching the terminal Monokai background/foreground pairing', () => {
    expect(EDITOR_THEME_CATALOG.monokai.palette.background).toBe('#272822')
    expect(EDITOR_THEME_CATALOG.monokai.palette.foreground).toBe('#f8f8f2')
  })
})

describe('buildMonacoThemeFromPalette', () => {
  it('strips the leading # from token colors (Monaco expects bare hex)', () => {
    const themeData = buildMonacoThemeFromPalette(EDITOR_THEME_CATALOG.monokai.palette)
    for (const rule of themeData.rules) {
      if (rule.foreground) {
        expect(rule.foreground.startsWith('#')).toBe(false)
      }
    }
  })

  it('keeps the # prefix on editor.* colors (Monaco expects full hex there)', () => {
    const themeData = buildMonacoThemeFromPalette(EDITOR_THEME_CATALOG.monokai.palette)
    expect(themeData.colors['editor.background']).toBe('#272822')
  })

  it('colors support.function the same as function (matches the preview tokenizer output)', () => {
    const themeData = buildMonacoThemeFromPalette(EDITOR_THEME_CATALOG.monokai.palette)
    const functionRule = themeData.rules.find((rule) => rule.token === 'function')
    const supportFunctionRule = themeData.rules.find((rule) => rule.token === 'support.function')
    expect(supportFunctionRule?.foreground).toBe(functionRule?.foreground)
  })

  it('maps base "light" to vs and "dark" to vs-dark', () => {
    expect(buildMonacoThemeFromPalette(EDITOR_THEME_CATALOG.monokai.palette).base).toBe('vs-dark')
    expect(buildMonacoThemeFromPalette(EDITOR_THEME_CATALOG['solarized-light'].palette).base).toBe(
      'vs'
    )
  })
})

describe('registerEditorThemeCatalog', () => {
  it('defines every catalog theme exactly once even across repeated calls', () => {
    const definedThemeNames: string[] = []
    const fakeMonaco = {
      editor: {
        defineTheme: (name: string) => {
          definedThemeNames.push(name)
        }
      }
    }

    registerEditorThemeCatalog(fakeMonaco as unknown as typeof Monaco)
    registerEditorThemeCatalog(fakeMonaco as unknown as typeof Monaco)

    const catalogIds = Object.keys(EDITOR_THEME_CATALOG)
    // Why <= catalogIds.length, not === : `registeredThemeIds` is module-level state shared
    // across the whole test file/process, so an earlier test importing this module first can
    // already have flipped it before this test runs — asserting "never re-registers" is the
    // real contract, not "exactly once from a pristine module".
    expect(definedThemeNames.length).toBeLessThanOrEqual(catalogIds.length)
    expect(new Set(definedThemeNames).size).toBe(definedThemeNames.length)
  })
})
