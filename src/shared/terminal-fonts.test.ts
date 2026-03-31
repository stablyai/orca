import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_FONT_WEIGHT,
  resolveTerminalFontWeights,
  normalizeTerminalFontWeight
} from './terminal-fonts'

describe('terminal font weights', () => {
  it('falls back to the Orca default when the value is missing', () => {
    expect(normalizeTerminalFontWeight(undefined)).toBe(DEFAULT_TERMINAL_FONT_WEIGHT)
  })

  it('clamps weights to the supported xterm range', () => {
    expect(normalizeTerminalFontWeight(10)).toBe(100)
    expect(normalizeTerminalFontWeight(1200)).toBe(900)
  })

  it('keeps bold text heavier than the base terminal weight', () => {
    expect(resolveTerminalFontWeights(500)).toEqual({
      fontWeight: 500,
      fontWeightBold: 700
    })
    expect(resolveTerminalFontWeights(800)).toEqual({
      fontWeight: 800,
      fontWeightBold: 900
    })
  })
})
