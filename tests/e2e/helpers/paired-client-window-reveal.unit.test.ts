import { describe, expect, it } from 'vitest'
import { assertPairedClientWindowRevealed } from './paired-client-window-reveal'

describe('assertPairedClientWindowRevealed', () => {
  it('accepts a window that the reveal made visible', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: true,
        wasVisible: false,
        windowCount: 1
      })
    ).not.toThrow()
  })

  it('accepts a window that was already visible', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: true,
        wasVisible: true,
        windowCount: 1
      })
    ).not.toThrow()
  })

  it('rejects a client with no window instead of letting the spec time out on a click', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: false,
        wasVisible: false,
        windowCount: 0
      })
    ).toThrow(/no BrowserWindow/)
  })

  it('rejects a window that stays hidden after show()', () => {
    expect(() =>
      assertPairedClientWindowRevealed({
        isVisible: false,
        wasVisible: false,
        windowCount: 2
      })
    ).toThrow(/stayed hidden after show\(\)/)
  })
})
