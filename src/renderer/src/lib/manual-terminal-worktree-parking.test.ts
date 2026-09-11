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
        worktreeId: 'worktree-1',
        reason: 'manual'
      })
    })
    window.addEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, listener)

    requestManualTerminalWorktreePark('worktree-1')

    expect(listener).toHaveBeenCalledOnce()
    expect(takePendingManualTerminalWorktreePark('worktree-1')).toBe('manual')
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

  it('carries the workspace-sleep reason through the event and the pending queue', () => {
    const details: ManualTerminalWorktreeParkDetail[] = []
    const listener = (event: Event): void => {
      details.push((event as CustomEvent<ManualTerminalWorktreeParkDetail>).detail)
    }
    window.addEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, listener)

    requestManualTerminalWorktreePark('worktree-2', 'workspace-sleep')

    expect(details).toEqual([{ worktreeId: 'worktree-2', reason: 'workspace-sleep' }])
    expect(takeAllPendingManualTerminalWorktreeParks()).toEqual([
      { worktreeId: 'worktree-2', reason: 'workspace-sleep' }
    ])
    window.removeEventListener(MANUAL_TERMINAL_WORKTREE_PARK_EVENT, listener)
  })
})
