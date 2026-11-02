import { describe, expect, it, vi } from 'vitest'
import { revealActivationDeferredTabs } from './background-terminal-worktree-mount'
import {
  createDeferredNarrowingUndo,
  undoTerminalPrewarmNarrowing
} from './terminal-worktree-prewarm'

describe('undoTerminalPrewarmNarrowing', () => {
  it('leaves an activated workspace able to admit its deferred tabs after the lease releases', () => {
    const leaseAllowed = new Set(['live'])
    const restrictions = new Map<string, ReadonlySet<string>>([['wt', leaseAllowed]])
    const deferred = new Map<string, ReadonlySet<string>>([['wt', new Set(['p1', 'p2'])]])
    // Activation installs its own restriction while keeping the same deferred tabs.
    restrictions.set('wt', new Set(['live']))

    undoTerminalPrewarmNarrowing({
      restrictions,
      deferredMountTabIdsByWorktree: deferred,
      worktreeId: 'wt',
      narrowing: { allowedTabIds: leaseAllowed, deferredTabIds: new Set(['p1', 'p2']) },
      isActivated: true
    })
    revealActivationDeferredTabs({
      restrictions,
      deferredMountTabIdsByWorktree: deferred,
      worktreeId: 'wt',
      allTabIds: ['live', 'p1', 'p2'],
      immediateTabIds: new Set(['p1'])
    })

    expect(restrictions.get('wt')).toEqual(new Set(['live', 'p1']))
    expect(deferred.get('wt')).toEqual(new Set(['p2']))
  })

  it('hands back a narrowing the lease still owns, keeping deferrals it did not add', () => {
    const leaseAllowed = new Set(['live'])
    const restrictions = new Map<string, ReadonlySet<string>>([['wt', leaseAllowed]])
    const deferred = new Map<string, ReadonlySet<string>>([['wt', new Set(['earlier', 'p1'])]])

    undoTerminalPrewarmNarrowing({
      restrictions,
      deferredMountTabIdsByWorktree: deferred,
      worktreeId: 'wt',
      narrowing: { allowedTabIds: leaseAllowed, deferredTabIds: new Set(['p1']) },
      isActivated: false
    })

    expect(restrictions.has('wt')).toBe(false)
    expect(deferred.get('wt')).toEqual(new Set(['earlier']))
  })
})

describe('createDeferredNarrowingUndo', () => {
  const narrowing = { allowedTabIds: new Set(['live']), deferredTabIds: new Set(['p1']) }

  it('waits out a newer measurement cool-down that would still leave tab parking off', () => {
    vi.useFakeTimers()
    try {
      const undo = vi.fn()
      vi.setSystemTime(0)
      // Another mount measured mid-delay, so its cool-down runs 22 s past the original deadline.
      const holdUntil = 53_000
      const undos = createDeferredNarrowingUndo({
        delayMs: 31_000,
        undo,
        remainingHoldMs: () => holdUntil - Date.now()
      })
      undos.schedule('wt', narrowing)
      vi.advanceTimersByTime(31_000)
      expect(undo).not.toHaveBeenCalled()
      vi.advanceTimersByTime(22_000)
      expect(undo).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('applies a pending undo at once when a new lease takes the worktree', () => {
    vi.useFakeTimers()
    try {
      const undo = vi.fn()
      const undos = createDeferredNarrowingUndo({
        delayMs: 31_000,
        undo,
        remainingHoldMs: () => null
      })
      undos.schedule('wt', narrowing)
      undos.flush('wt')
      expect(undo).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(31_000)
      expect(undo).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
