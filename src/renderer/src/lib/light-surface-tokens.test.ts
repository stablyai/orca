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

  it('keeps muted text legible on cream and the most-recessed surface (UI/secondary >= 3)', () => {
    expect(
      contrastRatio(LIGHT_MUTED_FOREGROUND_HEX, LIGHT_CONTENT_SURFACE_HEX)
    ).toBeGreaterThanOrEqual(3)
    expect(
      contrastRatio(LIGHT_MUTED_FOREGROUND_HEX, LIGHT_SURFACE_LADDER.muted)
    ).toBeGreaterThanOrEqual(3)
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
