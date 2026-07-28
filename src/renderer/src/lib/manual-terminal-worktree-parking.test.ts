// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MANUAL_TERMINAL_WORKTREE_PARK_EVENT,
  requestManualTerminalWorktreePark,
  takeAllPendingManualTerminalWorktreeParks,
  takePendingManualTerminalWorktreePark,
  type ManualTerminalWorktreeParkDetail
} from './manual-terminal-worktree-parking'

describe('manual terminal worktree parking requests', () => {
  beforeEach(() => {
    takeAllPendingManualTerminalWorktreeParks()
  })

  it('dispatches the target worktree and records it for a late Terminal mount', () => {
    const listener = vi.fn((event: Event) => {
      expect((event as CustomEvent<ManualTerminalWorktreeParkDetail>).detail).toEqual({
        worktreeId: 'worktree-1'
      })
    })
    window.addEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, listener)

    requestManualTerminalWorktreePark('worktree-1')

    expect(listener).toHaveBeenCalledOnce()
    expect(takePendingManualTerminalWorktreePark('worktree-1')).toBe(true)
    window.removeEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, listener)
  })

  it('ignores an empty worktree id', () => {
    const listener = vi.fn()
    window.addEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, listener)

    requestManualTerminalWorktreePark('')

    expect(listener).not.toHaveBeenCalled()
    expect(takeAllPendingManualTerminalWorktreeParks()).toEqual([])
    window.removeEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, listener)
  })
})
