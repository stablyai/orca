import { describe, expect, it } from 'vitest'
import { softMarkColors } from './repo-badge-color'

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((offset) => {
    const unit = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

describe('softMarkColors', () => {
  it('washes the fill and shifts the letters toward the theme', () => {
    expect(softMarkColors('#ef4444', 'dark')).toEqual({
      background: 'rgba(239, 68, 68, 0.14)',
      foreground: '#f69898'
    })
    expect(softMarkColors('#ef4444', 'light')).toEqual({
      background: 'rgba(239, 68, 68, 0.14)',
      foreground: '#832525'
    })
  })

  it('keeps letters readable for very dark and very light colors', () => {
    for (const color of ['#000000', '#111827', '#1e3a8a', '#3b0764']) {
      expect(contrast(softMarkColors(color, 'dark').foreground, '#171717')).toBeGreaterThanOrEqual(
        4.5
      )
    }
    for (const color of ['#ffffff', '#fef9c3', '#fde68a', '#eab308']) {
      expect(contrast(softMarkColors(color, 'light').foreground, '#fafafa')).toBeGreaterThanOrEqual(
        4.5
      )
    }
  })

  it('treats invalid input as the neutral default', () => {
    expect(softMarkColors('nope', 'dark').background).toBe('rgba(115, 115, 115, 0.14)')
  })
})
