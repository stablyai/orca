import { describe, expect, it } from 'vitest'
import { contrastRatio, type Rgba } from '../../../../shared/color/rgba-contrast'
import {
  ANSI_PALETTES,
  LOG_SURFACES,
  MIN_ANSI_CONTRAST,
  clampAnsiPalette
} from './build-log-ansi-palette'

function rgba(hex: string): Rgba {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
  return [r, g, b, 1]
}

describe.each(['dark', 'light'] as const)('build log ANSI palette (%s)', (theme) => {
  it('resolves all 16 colors to hex', () => {
    expect(ANSI_PALETTES[theme].fg).toHaveLength(16)
    for (const color of ANSI_PALETTES[theme].fg) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it.each([...Array(16).keys()])('color %i meets AA on every log surface', (index) => {
    const color = rgba(ANSI_PALETTES[theme].fg[index]!)
    for (const surface of LOG_SURFACES[theme]) {
      expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(MIN_ANSI_CONTRAST)
    }
  })
})

describe('clampAnsiPalette', () => {
  it('keeps passing colors and passes non-hex values through', () => {
    expect(clampAnsiPalette(['#000000', undefined, 'red'], 'light')).toEqual([
      '#000000',
      undefined,
      'red'
    ])
  })

  it('darkens a low-contrast yellow on light surfaces', () => {
    const [clamped] = clampAnsiPalette(['#c4a000'], 'light')
    expect(clamped).not.toBe('#c4a000')
    expect(contrastRatio(rgba(clamped!), LOG_SURFACES.light[0])).toBeGreaterThanOrEqual(4.5)
  })
})
