import { describe, expect, it } from 'vitest'
import { parseTerminalFontSizeInput, stepTerminalFontSize } from './terminal-font-size-steps'

describe('terminal font size steps', () => {
  it('keeps half sizes typed into the box and rounds other decimals to the nearest half', () => {
    expect(parseTerminalFontSizeInput('14.5')).toBe(14.5)
    expect(parseTerminalFontSizeInput('14')).toBe(14)
    expect(parseTerminalFontSizeInput('14.3')).toBe(14.5)
    expect(parseTerminalFontSizeInput('14.2')).toBe(14)
  })

  it('rejects empty and out-of-range input', () => {
    expect(parseTerminalFontSizeInput('')).toBeNull()
    expect(parseTerminalFontSizeInput('9.5')).toBeNull()
    expect(parseTerminalFontSizeInput('24.5')).toBeNull()
  })

  it('moves the - and + buttons by half a point and stops at the limits', () => {
    expect(stepTerminalFontSize(14, 1)).toBe(14.5)
    expect(stepTerminalFontSize(14.5, 1)).toBe(15)
    expect(stepTerminalFontSize(14.5, -1)).toBe(14)
    expect(stepTerminalFontSize(10, -1)).toBe(10)
    expect(stepTerminalFontSize(24, 1)).toBe(24)
  })
})
