import { describe, expect, it } from 'vitest'
import { hexToRgba, parseTerminalCssColor } from './terminal-css-color'

describe('parseTerminalCssColor', () => {
  it('parses the CSS colour forms xterm themes carry', () => {
    expect(parseTerminalCssColor('#abc')).toEqual({ rgb: [0xaa, 0xbb, 0xcc], alpha: 0xff })
    expect(parseTerminalCssColor('#abcd')).toEqual({ rgb: [0xaa, 0xbb, 0xcc], alpha: 0xdd })
    expect(parseTerminalCssColor('#aabbccdd')).toEqual({ rgb: [0xaa, 0xbb, 0xcc], alpha: 0xdd })
    expect(parseTerminalCssColor('rgba(1, 2, 3, 0.5)')).toEqual({ rgb: [1, 2, 3], alpha: 128 })
    expect(parseTerminalCssColor('#abcde')).toBeNull()
    expect(parseTerminalCssColor('blue')).toBeNull()
  })

  it('wraps out-of-range rgb() channels the way xterm packs them, so they stay publishable', () => {
    // xterm: (r << 24 | g << 16 | b << 8 | a) >>> 0, then read back byte by byte.
    expect(parseTerminalCssColor('rgb(300, 0, 999)')).toEqual({ rgb: [44, 3, 231], alpha: 0xff })
    expect(parseTerminalCssColor('rgba(300, 2, 3, 0.5)')).toEqual({ rgb: [44, 2, 3], alpha: 128 })
  })
})

describe('hexToRgba', () => {
  it('expands short hex and yields NaN channels for non-hex input', () => {
    expect(hexToRgba('#f0f', 0.5)).toBe('rgba(255, 0, 255, 0.5)')
    expect(parseTerminalCssColor(hexToRgba('rgb(1, 2, 3)', 0.5))).toBeNull()
  })
})
