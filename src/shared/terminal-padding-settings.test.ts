import { describe, expect, it } from 'vitest'
import { normalizeTerminalPadding } from './terminal-padding-settings'

describe('normalizeTerminalPadding', () => {
  it('rounds fractional padding to the nearest fitted pixel', () => {
    expect(normalizeTerminalPadding(1.5)).toBe(2)
    expect(normalizeTerminalPadding(2.49)).toBe(2)
  })

  it('keeps padding inside the settings range', () => {
    expect(normalizeTerminalPadding(-1)).toBe(0)
    expect(normalizeTerminalPadding(513)).toBe(512)
  })
})
