import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_FONT_WEIGHT_BOLD,
  resolveTerminalFontWeights,
  normalizeTerminalFontWeight,
  normalizeTerminalFontWeightBold
} from './terminal-fonts'

describe('terminal font weights', () => {
  it('clamps both weights to the supported xterm range', () => {
    expect(normalizeTerminalFontWeight(10)).toBe(100)
    expect(normalizeTerminalFontWeight(1200)).toBe(900)
    expect(normalizeTerminalFontWeightBold(10)).toBe(100)
    expect(normalizeTerminalFontWeightBold(1200)).toBe(900)
  })

  it('does not derive bold from the base weight', () => {
    expect(resolveTerminalFontWeights(800, undefined)).toEqual({
      fontWeight: 800,
      fontWeightBold: DEFAULT_TERMINAL_FONT_WEIGHT_BOLD
    })
    expect(resolveTerminalFontWeights(300, 400)).toEqual({
      fontWeight: 300,
      fontWeightBold: 400
    })
    expect(resolveTerminalFontWeights(700, 700)).toEqual({
      fontWeight: 700,
      fontWeightBold: 700
    })
  })
})
