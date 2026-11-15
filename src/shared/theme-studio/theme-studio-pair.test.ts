import { describe, expect, it } from 'vitest'
import { parseThemeColor, rgbaToOklch } from '../color/oklch-color-transform'
import { mirrorThemeColor, pairThemeStudioVariant } from './theme-studio-pair'

const lightness = (value: string): number => {
  const color = parseThemeColor(value)
  if (!color) {
    throw new Error(`not a color: ${value}`)
  }
  return rgbaToOklch(color).l
}

describe('theme pairing', () => {
  it('turns a dark surface light and light text dark, keeping hue', () => {
    expect(lightness(mirrorThemeColor('#1a1410', 'light') ?? '')).toBeGreaterThan(0.85)
    expect(lightness(mirrorThemeColor('#f4efea', 'light') ?? '')).toBeLessThan(0.2)
    const warm = rgbaToOklch(parseThemeColor('#3a2a1a') ?? [0, 0, 0, 1])
    const paired = rgbaToOklch(
      parseThemeColor(mirrorThemeColor('#3a2a1a', 'light') ?? '') ?? [0, 0, 0, 1]
    )
    expect(Math.abs(paired.h - warm.h)).toBeLessThan(8)
  })

  it('round-trips a surface and a text color back near where they started', () => {
    for (const value of ['#16120f', '#e8e2dc']) {
      const back = mirrorThemeColor(mirrorThemeColor(value, 'light') ?? '', 'dark') ?? ''
      expect(Math.abs(lightness(back) - lightness(value))).toBeLessThan(0.03)
    }
  })

  it('keeps ANSI black and white, and puts colored ANSI where it reads on the new background', () => {
    const { variant, kept } = pairThemeStudioVariant(
      {
        tokens: { '--background': '#101010', '--foreground': '#eeeeee', '--accent': 'inherit' },
        terminal: { background: '#101010', foreground: '#eeeeee', black: '#202020', red: '#ff8080' }
      },
      'light'
    )
    expect(variant.terminal?.black).toBe('#202020')
    expect(lightness(variant.terminal?.red ?? '')).toBeLessThanOrEqual(0.63)
    expect(lightness(variant.terminal?.background ?? '')).toBeGreaterThan(0.85)
    expect(kept).toEqual(['--accent'])
  })

  it('keeps a light background and its sidebar apart when making the dark variant', () => {
    const background = lightness(mirrorThemeColor('#ffffff', 'dark') ?? '')
    const sidebar = lightness(mirrorThemeColor('#f5f5f5', 'dark') ?? '')
    expect(sidebar - background).toBeGreaterThan(0.02)
    expect(background).toBeLessThan(0.15)
  })
})
