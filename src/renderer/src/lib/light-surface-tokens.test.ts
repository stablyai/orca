import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  LIGHT_CONTENT_SURFACE_HEX,
  LIGHT_FOREGROUND_HEX,
  LIGHT_MUTED_FOREGROUND_HEX,
  LIGHT_SURFACE_LADDER
} from './light-surface-tokens'

function relLuminance(hex: string): number {
  const n = hex.replace('#', '')
  const channel = (i: number): number => {
    const c = Number.parseInt(n.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

function contrastRatio(a: string, b: string): number {
  const la = relLuminance(a)
  const lb = relLuminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

describe('light surface tokens', () => {
  it('keeps the shared content value in sync with the ladder', () => {
    expect(LIGHT_SURFACE_LADDER.content).toBe(LIGHT_CONTENT_SURFACE_HEX)
    expect(LIGHT_CONTENT_SURFACE_HEX).toBe('#f6f4ef')
  })

  it('keeps primary text readable on the cream content surface (AA body >= 4.5)', () => {
    expect(contrastRatio(LIGHT_FOREGROUND_HEX, LIGHT_CONTENT_SURFACE_HEX)).toBeGreaterThanOrEqual(
      4.5
    )
  })

  it('keeps muted text at AA body contrast (>= 4.5) on the cream and most-recessed surfaces', () => {
    // Regression guard for the --muted / --muted-foreground pair (PR review #14410).
    expect(
      contrastRatio(LIGHT_MUTED_FOREGROUND_HEX, LIGHT_CONTENT_SURFACE_HEX)
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(LIGHT_MUTED_FOREGROUND_HEX, LIGHT_SURFACE_LADDER.muted)
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('forms a monotonic white->cream ladder (each step no lighter than the last)', () => {
    const order = [
      LIGHT_SURFACE_LADDER.background,
      LIGHT_SURFACE_LADDER.card,
      LIGHT_SURFACE_LADDER.sidebar,
      LIGHT_SURFACE_LADDER.content,
      LIGHT_SURFACE_LADDER.muted
    ]
    for (let i = 1; i < order.length; i++) {
      expect(relLuminance(order[i])).toBeLessThan(relLuminance(order[i - 1]))
    }
  })
})

describe('main.css mirrors the light token registry', () => {
  // The TS constants above can drift from the stylesheet (CSS can't import them),
  // so assert the first :root {} block (default light mode) uses the same values.
  const css = readFileSync(new URL('../assets/main.css', import.meta.url), 'utf8')
  const rootStart = css.indexOf(':root {')
  const rootBlock = css.slice(rootStart, css.indexOf('}', rootStart))

  const tokenValue = (name: string): string | null => {
    const match = rootBlock.match(new RegExp(`(?:^|\\n)\\s*--${name}:\\s*([^;]+);`))
    return match ? match[1].trim() : null
  }

  it.each([
    ['background', LIGHT_SURFACE_LADDER.background],
    ['foreground', LIGHT_FOREGROUND_HEX],
    ['card', LIGHT_SURFACE_LADDER.card],
    ['popover', LIGHT_SURFACE_LADDER.card],
    ['sidebar', LIGHT_SURFACE_LADDER.sidebar],
    ['editor-surface', LIGHT_SURFACE_LADDER.content],
    ['muted', LIGHT_SURFACE_LADDER.muted],
    ['muted-foreground', LIGHT_MUTED_FOREGROUND_HEX]
  ])('--%s in main.css matches the registry', (name, expected) => {
    expect(tokenValue(name)).toBe(expected)
  })
})
