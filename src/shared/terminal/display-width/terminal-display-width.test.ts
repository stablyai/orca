import { describe, expect, it } from 'vitest'
import { padEndToTerminalWidth } from './terminal-display-width'

describe('padEndToTerminalWidth', () => {
  // Widths match Orca's xterm Unicode11 + ZWJ provider, the terminal the CLI usually prints into.
  it.each([
    ['Alice', 5],
    ['김철수', 6],
    ['é', 1],
    ['각', 2],
    ['👍🏽', 4],
    ['👨‍👩‍👧', 2],
    ['🇺🇸', 2],
    ['क्ष', 2],
    ['㉈', 1],
    ['a\u00adb', 3]
  ])('pads %j as %i columns', (text, width) => {
    expect(padEndToTerminalWidth(text, 10)).toBe(text + ' '.repeat(10 - width))
  })

  it('never truncates text wider than the column', () => {
    expect(padEndToTerminalWidth('김철수', 4)).toBe('김철수')
  })
})
