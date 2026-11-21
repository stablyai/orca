import { describe, expect, it } from 'vitest'
import type { ColorProbe } from '../../../app-shell/appearance/plugin-theme-tokens'
import { codeEditorSyntaxColors } from './code-editor-syntax-colors'
import { derivePluginMonacoTheme } from './plugin-monaco-theme'

const hexProbe: ColorProbe = (value) => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value.trim())
  return match
    ? [
        Number.parseInt(match[1], 16),
        Number.parseInt(match[2], 16),
        Number.parseInt(match[3], 16),
        1
      ]
    : null
}

describe('codeEditorSyntaxColors', () => {
  it("reports Monaco's built-in colors, and editor text where it has none", () => {
    const colors = codeEditorSyntaxColors({ monaco: null, override: null }, 'dark')
    expect(colors.comment).toBe('#608b4e')
    expect(colors.attribute).toBe('#9cdcfe')
    expect(colors.function).toBe('#d4d4d4')
  })

  it("follows an editor theme chosen apart from the app's mode", () => {
    const override = {
      base: 'light' as const,
      colors: { background: '#fffffe', foreground: '#000000', mutedForeground: '', border: '' }
    }
    const colors = codeEditorSyntaxColors({ monaco: null, override }, 'dark')
    expect(colors.keyword).toBe('#0000ff')
    expect(colors.operator).toBe('#000000')
  })

  it("takes a plugin theme's tokenColors by scope, keeping built-ins for the rest", () => {
    const tokens: Record<string, string> = { '--background': '#1e1e1e', '--foreground': '#eeeeee' }
    const monaco = derivePluginMonacoTheme({
      base: 'dark',
      read: (token) => tokens[token] ?? '',
      painted: tokens,
      probe: hexProbe,
      tokenColors: [
        { scope: 'entity.name.function', settings: { foreground: '#DCDCAA' } },
        { scope: ['keyword', 'storage.type'], settings: { foreground: '#C586C0' } }
      ]
    })
    expect(monaco).not.toBeNull()
    const colors = codeEditorSyntaxColors({ monaco, override: null }, 'dark')
    expect(colors.function).toBe('#dcdcaa')
    expect(colors.keyword).toBe('#c586c0')
    // `keyword.operator` falls back to the theme's `keyword`, as in the editor.
    expect(colors.operator).toBe('#c586c0')
    expect(colors.comment).toBe('#608b4e')
    expect(colors.variable).toBe('#74b0df')
  })
})
