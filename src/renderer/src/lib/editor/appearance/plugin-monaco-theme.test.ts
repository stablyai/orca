import { describe, expect, it } from 'vitest'
import type { PluginThemeTokenColorRule } from '../../../../../shared/plugins/artifacts/plugin-theme-artifact'
import { contrastRatio, hexToRgb, over, type Rgba } from '../../../../../shared/color/rgba-contrast'
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

const WHITE: Rgba = [255, 255, 255, 1]

function rgba(value: string): Rgba {
  const [r, g, b] = hexToRgb(value)
  return [r, g, b, value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1]
}

function theme(
  tokens: Record<string, string> = TOKENS,
  tokenColors: readonly PluginThemeTokenColorRule[] = []
) {
  return derivePluginMonacoTheme({
    base: 'light',
    read: (token) => tokens[token] ?? '',
    painted: { '--text-link': tokens['--text-link']! },
    probe: (value) => (/^#[0-9a-f]{6}$/i.test(value) ? hexToRgb(value) : null),
    tokenColors
  })
}

function findColors(
  tokens: Record<string, string>,
  tokenColors?: readonly PluginThemeTokenColorRule[]
) {
  const colors = theme(tokens, tokenColors)!.data.colors!
  return {
    active: colors['editor.findMatchBackground'],
    inactive: colors['editor.findMatchHighlightBackground']
  }
}

describe('derivePluginMonacoTheme selection colors', () => {
  it('uses the theme accent for selection and keeps the active find match stronger', () => {
    const colors = theme()!.data.colors!
    const selection = hexToRgb(colors['editor.selectionBackground']!)
    expect(selection[0]).toBeGreaterThan(selection[1])
    expect(selection[1]).toBe(selection[2])

    const activeHex = colors['editor.findMatchBackground']
    const inactiveHex = colors['editor.findMatchHighlightBackground']
    expect(Boolean(activeHex)).toBe(Boolean(inactiveHex))
    if (activeHex && inactiveHex) {
      const active = rgba(activeHex)
      const inactive = rgba(inactiveHex)
      expect(active[3]).toBeGreaterThan(inactive[3])
      expect(contrastRatio(over(active, WHITE), WHITE)).toBeGreaterThan(
        contrastRatio(over(inactive, WHITE), WHITE)
      )
    }
  })

  it('keeps built-in syntax text readable on an opaque selection surface', () => {
    const colors = theme({ ...TOKENS, '--text-link': '#000000' })!.data.colors!
    const raw = rgba(colors['editor.selectionBackground']!)
    expect(raw[3]).toBe(1)
    expect(colors['editor.selectionBackground']).not.toBe('#8888884d')

    const selection = over(raw, WHITE)
    expect(contrastRatio(hexToRgb('#008000'), selection)).toBeGreaterThanOrEqual(3)
  })

  it('falls back to the ring when the accent cannot read as a surface', () => {
    const colors = theme({ ...TOKENS, '--text-link': '#ffffff' })!.data.colors!
    expect(colors['editor.selectionBackground']).toMatch(/^#8888884d$/)
  })

  it('uses the note accent when an editor-only theme paints no link color', () => {
    const colors = theme({ ...TOKENS, '--text-link': '', '--callout-note': '' })!.data.colors!
    expect(colors['editor.selectionBackground']).not.toBe('#8888884d')
    expect(rgba(colors['editor.selectionBackground']!)[3]).toBe(1)
  })

  it('ignores token foregrounds Monaco will not paint', () => {
    const colors = theme(TOKENS, [{ scope: 'comment', settings: { foreground: '#ffffff' } }])!.data
      .colors!
    expect(colors['editor.selectionBackground']).not.toBe('#8888884d')
    expect(rgba(colors['editor.selectionBackground']!)[3]).toBe(1)
  })

  it('overrides find colors only as a pair', () => {
    for (const tokens of [
      TOKENS,
      { ...TOKENS, '--foreground': '#565656', '--text-link': '#000000' }
    ]) {
      const { active, inactive } = findColors(tokens)
      expect(Boolean(active)).toBe(Boolean(inactive))
    }
  })
})
