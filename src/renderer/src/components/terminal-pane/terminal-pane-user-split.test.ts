import { describe, expect, it, vi } from 'vitest'
import { runTerminalPaneUserSplit } from './terminal-pane-user-split'

describe('runTerminalPaneUserSplit', () => {
  it('rejects user split entry points for maintained grids', () => {
    const split = vi.fn()

    expect(runTerminalPaneUserSplit(false, split)).toBe(false)
    expect(split).not.toHaveBeenCalled()
  })

  it('preserves ordinary terminal split behavior', () => {
    const split = vi.fn()

    expect(runTerminalPaneUserSplit(true, split)).toBe(true)
    expect(split).toHaveBeenCalledOnce()
  })
})
