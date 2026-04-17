import { describe, expect, it } from 'vitest'
import { shouldIgnoreTerminalMenuPointerDownOutside } from './terminal-context-menu-dismiss'

describe('shouldIgnoreTerminalMenuPointerDownOutside', () => {
  it('ignores the opening gesture immediately after the menu opens', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_050,
        button: 0,
        ctrlKey: false,
        isMac: false
      })
    ).toBe(true)
  })

  it('ignores secondary-button pointerdowns after the menu is open', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_250,
        button: 2,
        ctrlKey: false,
        isMac: false
      })
    ).toBe(true)
  })

  it('treats macOS control-click as a context-menu gesture', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_250,
        button: 0,
        ctrlKey: true,
        isMac: true
      })
    ).toBe(true)
  })

  it('allows ordinary outside left-click dismissals', () => {
    expect(
      shouldIgnoreTerminalMenuPointerDownOutside({
        openedAtMs: 1_000,
        nowMs: 1_250,
        button: 0,
        ctrlKey: false,
        isMac: false
      })
    ).toBe(false)
  })
})
