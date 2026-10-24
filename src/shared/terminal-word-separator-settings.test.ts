import { describe, expect, it } from 'vitest'
import { normalizeTerminalWordSeparator } from './terminal-word-separator-settings'

describe('normalizeTerminalWordSeparator', () => {
  it.each([
    [undefined, undefined],
    [null, undefined],
    [42, undefined],
    ['', undefined]
  ])('returns undefined for %s so the xterm default applies', (input, expected) => {
    expect(normalizeTerminalWordSeparator(input)).toBe(expected)
  })

  it('adds missing whitespace to a custom separator list', () => {
    expect(normalizeTerminalWordSeparator(`()[]{},'"-`)).toBe(` \t()[]{},'"-`)
  })

  it('does not duplicate whitespace already present', () => {
    expect(normalizeTerminalWordSeparator(` ()[]{},'"`)).toBe(`\t ()[]{},'"`)
    expect(normalizeTerminalWordSeparator(` \t()`)).toBe(` \t()`)
  })
})
