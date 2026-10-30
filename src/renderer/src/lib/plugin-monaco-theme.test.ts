import { describe, expect, it } from 'vitest'
import { derivePluginMonacoTheme } from './plugin-monaco-theme'
import type { ColorProbe } from './plugin-theme-tokens'

// Parses #rrggbb and #rrggbbaa, which is all these tests feed it.
const probe: ColorProbe = (value) => {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim())
  if (!match?.[1]) {
    return null
  }
  const channel = (offset: number): number =>
    Number.parseInt(match[1]?.slice(offset, offset + 2) ?? '0', 16)
  return [channel(0), channel(2), channel(4), match[2] ? Number.parseInt(match[2], 16) / 255 : 1]
}

const dusk: Record<string, string> = {
  '--editor-surface': '#1b1430',
  '--foreground': '#e8e0ff',
  '--muted-foreground': '#b9add6',
  '--accent': '#3a1f6e',
  '--ring': '#ff2bd6',
  '--popover': '#2a1450',
  '--border': '#5b3f9c'
}

function derive(tokens: Record<string, string>, base: 'light' | 'dark' = 'dark') {
  return derivePluginMonacoTheme({ base, read: (token) => tokens[token] ?? '', probe })
}

describe('derivePluginMonacoTheme', () => {
  it('builds an editor theme from the painted colors on the matching built-in syntax colors', () => {
    const theme = derive(dusk)
    expect(theme?.data).toMatchObject({
      base: 'vs-dark',
      inherit: true,
      colors: { 'editor.background': '#1b1430', 'editor.foreground': '#e8e0ff' }
    })
    // The name follows the colors, so an update or mode change defines a fresh theme.
    expect(derive(dusk)?.name).toBe(theme?.name)
    expect(derive({ ...dusk, '--editor-surface': '#120d22' })?.name).not.toBe(theme?.name)
  })

  it('works for a light theme that sets only background and foreground', () => {
    const theme = derive({ '--background': '#fff4e6', '--foreground': '#3b1d0a' }, 'light')
    expect(theme?.data.base).toBe('vs')
    expect(theme?.data.colors['editor.background']).toBe('#fff4e6')
    expect(theme?.data.colors).not.toHaveProperty('editorWidget.background')
  })

  it('keeps the built-in editor when text or syntax colors would lose contrast', () => {
    expect(derive({ ...dusk, '--foreground': '#2a2040' })).toBeNull()
    // The dark syntax colors can't be read on a pale background.
    expect(derive({ ...dusk, '--editor-surface': '#f0f0f0', '--foreground': '#111111' })).toBeNull()
    expect(derive({ ...dusk, '--editor-surface': '#1b143080' })).toBeNull()
    expect(derive({ ...dusk, '--editor-surface': 'not-a-color', '--background': '' })).toBeNull()
  })

  it("paints the theme's tokenColors, blending translucent ones and dropping unreadable ones", () => {
    const theme = derivePluginMonacoTheme({
      base: 'dark',
      read: (token) => dusk[token] ?? '',
      probe,
      tokenColors: [
        { scope: 'keyword', settings: { foreground: '#ff2bd6' } },
        { scope: 'string', settings: { foreground: '#ffffff80' } },
        { scope: 'comment', settings: { foreground: '#241a3a', fontStyle: 'italic' } }
      ]
    })
    const rules = theme?.data.rules ?? []
    expect(rules).toContainEqual({ token: 'keyword', foreground: '#ff2bd6' })
    expect(rules).toContainEqual({ token: 'string', foreground: '#8d8a98' })
    expect(rules).toContainEqual({ token: 'comment', fontStyle: 'italic' })
    expect(theme?.name).not.toBe(derive(dusk)?.name)
  })
})
