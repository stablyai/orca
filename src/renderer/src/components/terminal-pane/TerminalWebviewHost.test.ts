import { describe, expect, it } from 'vitest'
import { shouldFocusTerminalWebview } from './TerminalWebviewHost'

describe('shouldFocusTerminalWebview', () => {
  it('only focuses an active pane in the visible worktree', () => {
    expect(
      shouldFocusTerminalWebview({
        isActive: true,
        isVisible: true,
        isWorktreeActive: true
      })
    ).toBe(true)
    expect(
      shouldFocusTerminalWebview({
        isActive: false,
        isVisible: true,
        isWorktreeActive: true
      })
    ).toBe(false)
    expect(
      shouldFocusTerminalWebview({
        isActive: true,
        isVisible: false,
        isWorktreeActive: true
      })
    ).toBe(false)
    expect(
      shouldFocusTerminalWebview({
        isActive: true,
        isVisible: true,
        isWorktreeActive: false
      })
    ).toBe(false)
  })
})
