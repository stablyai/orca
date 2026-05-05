import { describe, expect, it } from 'vitest'
import { shouldIgnoreTerminalMenuPointerDownOutside } from './terminal-context-menu-dismiss'

describe('shouldIgnoreTerminalMenuPointerDownOutside', () => {
  it('ignores the opening gesture immediately after the menu opens', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_050
      })
    ).toBe(true)
  })

  it('allows secondary-button pointerdowns after the menu is open', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_250
      })
    ).toBe(false)
  })

  it('allows macOS control-click after the opening-gesture window', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_250
      })
    ).toBe(false)
  })

  it('allows ordinary outside left-click dismissals', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_250
      })
    ).toBe(false)
  })
})
