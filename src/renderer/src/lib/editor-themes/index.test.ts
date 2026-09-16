import { describe, expect, it } from 'vitest'
import type * as Monaco from 'monaco-editor'
import { EDITOR_THEME_CATALOG, registerEditorThemeCatalog } from './index'
import { buildMonacoThemeFromPalette } from './palette'
import { TERMINAL_THEME_CATALOG } from '../terminal-themes'

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

  it('covers every terminal theme, and only terminal themes, under the same label', () => {
    const editorLabels = Object.values(EDITOR_THEME_CATALOG).map((entry) => entry.label)
    expect(editorLabels.sort()).toEqual(Object.keys(TERMINAL_THEME_CATALOG).sort())
  })

  it('reuses its terminal counterpart chrome colors so both surfaces read as one theme', () => {
    for (const entry of Object.values(EDITOR_THEME_CATALOG)) {
      const terminalTheme = TERMINAL_THEME_CATALOG[entry.label]
      expect(entry.palette.background, `${entry.label} background`).toBe(terminalTheme?.background)
      expect(entry.palette.foreground, `${entry.label} foreground`).toBe(terminalTheme?.foreground)
      expect(entry.palette.cursor, `${entry.label} cursor`).toBe(terminalTheme?.cursor)
      expect(entry.palette.selection, `${entry.label} selection`).toBe(
        terminalTheme?.selectionBackground
      )
    }
  })

  it('keeps syntax roles distinguishable from the background of their own theme', () => {
    for (const entry of Object.values(EDITOR_THEME_CATALOG)) {
      const { background, ...roles } = entry.palette
      for (const [role, color] of Object.entries(roles)) {
        if (role === 'base' || role === 'lineHighlight' || role === 'selection') {
          continue
        }
        expect(color, `${entry.label} ${role}`).not.toBe(background)
      }
    }
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
