import { describe, expect, it } from 'vitest'
import { adjustThemeColor, parseThemeColor } from './oklch-color-transform'

describe('parseThemeColor', () => {
  it('reads the color syntaxes a theme token accepts', () => {
    expect(parseThemeColor('#f80')).toEqual([255, 136, 0, 1])
    expect(parseThemeColor('#ff880080')).toEqual([255, 136, 0, 128 / 255])
    expect(parseThemeColor('rgb(255 136 0 / 50%)')).toEqual([255, 136, 0, 0.5])
    expect(parseThemeColor('rgba(10, 20, 30, 0.25)')).toEqual([10, 20, 30, 0.25])
    expect(parseThemeColor('hsl(0 100% 50%)')).toEqual([255, 0, 0, 1])
    const oklchWhite = parseThemeColor('oklch(1 0 0)')
    expect(oklchWhite?.map((channel) => Math.round(channel))).toEqual([255, 255, 255, 1])
  })

  it('refuses names and mixes, which it cannot convert', () => {
    expect(parseThemeColor('rebeccapurple')).toBeNull()
    expect(parseThemeColor('color-mix(in srgb, red 50%, blue)')).toBeNull()
  })
})

describe('adjustThemeColor', () => {
  it('warms a neutral grey toward amber and cools it toward blue', () => {
    const warm = parseThemeColor(adjustThemeColor('#808080', { warmth: 100 }) ?? '')
    const cool = parseThemeColor(adjustThemeColor('#808080', { warmth: -100 }) ?? '')
    expect(warm && warm[0] > warm[2]).toBe(true)
    expect(cool && cool[2] > cool[0]).toBe(true)
  })

  it('never turns a blue purple when warming it', () => {
    const blue = parseThemeColor(adjustThemeColor('#282c34', { warmth: 45 }) ?? '')
    expect(blue && blue[0] <= blue[1] + 2).toBe(true)
  })

  it('moves contrast away from the canvas the color sits on', () => {
    const onLight = parseThemeColor(adjustThemeColor('#f0f0f0', { contrast: 50 }, '#ffffff') ?? '')
    const onDark = parseThemeColor(adjustThemeColor('#202020', { contrast: 50 }, '#101010') ?? '')
    expect(onLight && onLight[0] < 0xf0).toBe(true)
    expect(onDark && onDark[0] > 0x20).toBe(true)
  })

  it('keeps alpha and returns null for colors it cannot read', () => {
    expect(adjustThemeColor('#00000080', { lightness: 50 })?.endsWith('80')).toBe(true)
    expect(adjustThemeColor('transparent', { lightness: 50 })).toBeNull()
  })
})
