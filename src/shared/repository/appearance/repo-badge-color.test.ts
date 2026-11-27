import { describe, expect, it } from 'vitest'
import { REPO_COLORS, softMarkColors } from './repo-badge-color'

function parseRgba(rgba: string): [number, number, number, number] {
  const match = rgba.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/)
  if (!match) {
    throw new Error(`Unexpected rgba: ${rgba}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])]
}

function composite(rgba: string, surface: [number, number, number]): [number, number, number] {
  const [r, g, b, a] = parseRgba(rgba)
  return [
    Math.round(r * a + surface[0] * (1 - a)),
    Math.round(g * a + surface[1] * (1 - a)),
    Math.round(b * a + surface[2] * (1 - a))
  ]
}

function luminance(channels: [number, number, number]): number {
  const [r, g, b] = channels.map((value) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function hexChannels(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ]
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

describe('softMarkColors', () => {
  it('washes the fill and shifts the letters toward the theme', () => {
    expect(softMarkColors('#ef4444', 'dark')).toEqual({
      background: 'rgba(239, 68, 68, 0.2)',
      foreground: '#f9bebe'
    })
    expect(softMarkColors('#ef4444', 'light')).toEqual({
      background: 'rgba(239, 68, 68, 0.2)',
      foreground: '#601b1b'
    })
  })

  it('keeps letters clearly readable over sidebar accent surfaces for all palette, dark, and light colors', () => {
    for (const color of [...REPO_COLORS, '#000000', '#111827', '#1e3a8a', '#3b0764']) {
      const dark = softMarkColors(color, 'dark')
      expect(
        contrast(hexChannels(dark.foreground), composite(dark.background, [53, 53, 53]))
      ).toBeGreaterThanOrEqual(6)
    }
    for (const color of [...REPO_COLORS, '#ffffff', '#fef9c3', '#fde68a', '#eab308']) {
      const light = softMarkColors(color, 'light')
      expect(
        contrast(hexChannels(light.foreground), composite(light.background, [234, 234, 234]))
      ).toBeGreaterThanOrEqual(6)
    }
  })

  it('treats invalid input as the neutral default', () => {
    expect(softMarkColors('nope', 'dark')).toEqual(softMarkColors(REPO_COLORS[0], 'dark'))
  })
})
