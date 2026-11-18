import { describe, expect, it } from 'vitest'
import { contrastRatio, hexToRgb } from '../../../../../shared/color/rgba-contrast'
import { derivePluginMonacoTheme } from './plugin-monaco-theme'

const TOKENS: Record<string, string> = {
  '--editor-surface': '#ffffff',
  '--background': '#ffffff',
  '--foreground': '#111111',
  '--muted-foreground': '#666666',
  '--ring': '#888888',
  '--accent': '#eeeeee',
  '--text-link': '#cc1111',
  '--callout-note': '#0969da',
  '--popover': '#ffffff',
  '--border': '#dddddd'
}

function theme(tokens: Record<string, string> = TOKENS) {
  return derivePluginMonacoTheme({
    base: 'light',
    read: (token) => tokens[token] ?? '',
    painted: { '--text-link': tokens['--text-link']! },
    probe: (value) => (/^#[0-9a-f]{6}$/i.test(value) ? hexToRgb(value) : null),
    tokenColors: []
  })
}

describe('derivePluginMonacoTheme selection colors', () => {
  it('uses the theme accent for selection and keeps the active find match stronger', () => {
    const colors = theme()!.data.colors!
    const selection = hexToRgb(colors['editor.selectionBackground']!)
    expect(selection[0]).toBeGreaterThan(selection[1])
    expect(selection[1]).toBe(selection[2])

    const background = hexToRgb('#ffffff')
    const active = hexToRgb(colors['editor.findMatchBackground']!)
    const inactive = hexToRgb(colors['editor.findMatchHighlightBackground']!)
    expect(contrastRatio(active, background)).toBeGreaterThan(contrastRatio(inactive, background))
  })

  it('falls back to the ring when the accent cannot read as a surface', () => {
    const colors = theme({ ...TOKENS, '--text-link': '#ffffff' })!.data.colors!
    expect(colors['editor.selectionBackground']).toMatch(/^#8888884d$/)
  })
})
