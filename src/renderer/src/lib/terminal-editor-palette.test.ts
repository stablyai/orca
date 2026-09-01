import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import {
  buildMonacoThemeData,
  buildSyntaxTokenVariables,
  mixHexColors,
  resolveTerminalEditorPalette,
  TERMINAL_MONACO_THEME_NAME,
  toHexColor
} from './terminal-editor-palette'

/** Solarized Light as a Warp-imported custom theme, selected as the (single) terminal theme. */
const SOLARIZED_LIGHT = {
  id: 'warp:solarized-light',
  name: 'Solarized Light',
  source: 'warp' as const,
  mode: 'light' as const,
  importedAt: '2026-01-01T00:00:00.000Z',
  terminal: {
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    selectionBackground: '#eee8d5',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3'
  }
}

/** Settings fixture in match-terminal mode with a light custom terminal theme. */
function matchTerminalSettings(overrides = {}) {
  return {
    ...getDefaultSettings(tmpdir()),
    workspaceChromeAppearanceMode: 'match-terminal' as const,
    terminalCustomThemes: [SOLARIZED_LIGHT],
    terminalThemeDark: 'custom:warp:solarized-light',
    terminalUseSeparateLightTheme: false,
    ...overrides
  }
}

describe('resolveTerminalEditorPalette', () => {
  it('keeps the app editor theme unless the chrome follows the terminal', () => {
    expect(
      resolveTerminalEditorPalette(
        matchTerminalSettings({ workspaceChromeAppearanceMode: 'default' }),
        true
      )
    ).toBeNull()
    expect(
      resolveTerminalEditorPalette(
        matchTerminalSettings({ workspaceChromeAppearanceMode: undefined }),
        true
      )
    ).toBeNull()
    expect(resolveTerminalEditorPalette(null, true)).toBeNull()
  })

  it('rates light/dark by the terminal background, not the OS scheme', () => {
    const palette = resolveTerminalEditorPalette(matchTerminalSettings(), true)
    expect(palette).not.toBeNull()
    expect(palette?.isDark).toBe(false)
    expect(palette?.background).toBe('#fdf6e3')
    expect(palette?.foreground).toBe('#657b83')
    expect(palette?.cursor).toBe('#586e75')
    expect(palette?.selection).toBe('#eee8d5')
  })

  it('maps syntax roles onto the ANSI palette and mutes comments toward the background', () => {
    const palette = resolveTerminalEditorPalette(matchTerminalSettings(), true)
    expect(palette?.syntax).toMatchObject({
      keyword: '#d33682',
      string: '#859900',
      number: '#2aa198',
      function: '#268bd2',
      type: '#b58900',
      variable: '#dc322f',
      tag: '#268bd2',
      link: '#268bd2',
      addition: '#859900',
      deletion: '#dc322f'
    })
    expect(palette?.syntax.comment).toBe(mixHexColors('#657b83', '#fdf6e3', 62))
  })

  it('mutes comments toward the background on a high-contrast theme', () => {
    const palette = resolveTerminalEditorPalette(
      matchTerminalSettings({
        terminalColorOverrides: { background: '#000000', foreground: '#ffffff' }
      }),
      true
    )
    expect(palette?.syntax.comment).toBe('#9e9e9e')
  })

  it('lets color overrides win over the selected theme', () => {
    const palette = resolveTerminalEditorPalette(
      matchTerminalSettings({
        terminalColorOverrides: { background: '#101820', magenta: '#ff00ff' }
      }),
      false
    )
    expect(palette?.background).toBe('#101820')
    expect(palette?.isDark).toBe(true)
    expect(palette?.syntax.keyword).toBe('#ff00ff')
  })

  it('keeps the Monaco surface opaque when the terminal background is translucent', () => {
    const palette = resolveTerminalEditorPalette(
      matchTerminalSettings({ terminalBackgroundOpacity: 0.5 }),
      true
    )
    expect(palette?.background).toBe('#fdf6e3')
  })
})

describe('buildSyntaxTokenVariables', () => {
  it('exposes every syntax role as a --syntax-* variable', () => {
    const palette = resolveTerminalEditorPalette(matchTerminalSettings(), true)!
    const vars = buildSyntaxTokenVariables(palette)
    expect(vars['--syntax-keyword']).toBe('#d33682')
    expect(vars['--syntax-comment']).toBe(palette.syntax.comment)
    expect(Object.keys(vars).sort()).toEqual(
      Object.keys(palette.syntax)
        .map((role) => `--syntax-${role}`)
        .sort()
    )
  })
})

describe('buildMonacoThemeData', () => {
  it('picks the vs base for a light terminal theme and paints the editor with its colors', () => {
    const palette = resolveTerminalEditorPalette(matchTerminalSettings(), true)!
    const theme = buildMonacoThemeData(palette)
    expect(TERMINAL_MONACO_THEME_NAME).toBe('orca-terminal')
    expect(theme.base).toBe('vs')
    expect(theme.colors['editor.background']).toBe('#fdf6e3')
    expect(theme.colors['editor.foreground']).toBe('#657b83')
    expect(theme.colors['editorCursor.foreground']).toBe('#586e75')
    expect(theme.colors['editor.selectionBackground']).toBe('#eee8d5')
    expect(theme.rules).toContainEqual({ token: 'keyword', foreground: 'd33682' })
    expect(theme.rules).toContainEqual({ token: 'string', foreground: '859900' })
    expect(theme.rules).toContainEqual({
      token: 'comment',
      foreground: palette.syntax.comment.slice(1),
      fontStyle: 'italic'
    })
  })

  it('picks the vs-dark base for a dark terminal theme', () => {
    const palette = resolveTerminalEditorPalette(
      matchTerminalSettings({
        terminalColorOverrides: { background: '#101820', foreground: '#f0f4f8' }
      }),
      true
    )!
    expect(buildMonacoThemeData(palette).base).toBe('vs-dark')
  })

  it('only emits hex colors, which is all Monaco accepts', () => {
    const palette = resolveTerminalEditorPalette(matchTerminalSettings(), true)!
    const theme = buildMonacoThemeData(palette)
    for (const value of Object.values(theme.colors)) {
      expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
    }
    for (const rule of theme.rules) {
      expect(rule.foreground).toMatch(/^[0-9a-f]{6}$/)
    }
  })
})

describe('color helpers', () => {
  it('normalizes css colors to hex and preserves alpha only when translucent', () => {
    expect(toHexColor('#abc')).toBe('#aabbcc')
    expect(toHexColor('rgb(16, 24, 32)')).toBe('#101820')
    expect(toHexColor('rgba(16, 24, 32, 0.5)')).toBe('#10182080')
    expect(toHexColor('not-a-color')).toBeNull()
  })

  it('mixes foreground into background by weight', () => {
    expect(mixHexColors('#ffffff', '#000000', 50)).toBe('#808080')
    expect(mixHexColors('#ffffff', '#000000', 0)).toBe('#000000')
    expect(mixHexColors('#ffffff', '#000000', 100)).toBe('#ffffff')
    expect(mixHexColors('bogus', '#000000', 50)).toBe('bogus')
  })
})
