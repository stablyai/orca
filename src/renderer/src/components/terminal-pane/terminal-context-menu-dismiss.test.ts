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

  it('allows ordinary outside left-click dismissals', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_250
      })
    ).toBe(false)
  })
})
