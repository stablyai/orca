import { describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { revealActivationDeferredTabs } from './background-terminal-worktree-mount'
import {
  areTabSessionsConfirmed,
  createDeferredNarrowingUndo,
  planTerminalPrewarmTabMount,
  undoTerminalPrewarmNarrowing
} from './terminal-worktree-prewarm'

function tab(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId: 'wt',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

const plan = (
  tabs: TerminalTab[],
  revealTabIds: string[],
  options: { live?: string[]; sleeping?: string[]; lostSessions?: string[] } = {}
) =>
  planTerminalPrewarmTabMount({
    tabs,
    revealTabIds: new Set(revealTabIds),
    isTabLive: (tabId) => options.live?.includes(tabId) === true,
    isTabRestorable: (candidate) => candidate.ptyId !== null,
    isTabSleeping: (tabId) => options.sleeping?.includes(tabId) === true,
    isSessionConfirmedLive: (candidate) => options.lostSessions?.includes(candidate.id) !== true
  })

describe('planTerminalPrewarmTabMount', () => {
  it('mounts only the revealable tab and keeps restorable siblings parked', () => {
    expect(plan([tab('a', 'pty-a'), tab('b', 'pty-b'), tab('c', null)], ['a'])).toEqual({
      allowedTabIds: new Set(['a']),
      deferredTabIds: new Set(['b'])
    })
  })

  it('admits a live revealable tab without spawning its unrestorable siblings', () => {
    expect(plan([tab('a', 'pty-a'), tab('c', null)], ['a'], { live: ['a'] })).toEqual({
      allowedTabIds: new Set(['a']),
      deferredTabIds: new Set()
    })
  })

  it('never mounts a revealable tab that would spawn a shell or wake a sleeping agent', () => {
    expect(plan([tab('a', null)], ['a'])).toBeNull()
    expect(plan([tab('a', 'pty-a')], ['a'], { sleeping: ['a'] })).toBeNull()
  })

  it('never reattaches a revealable tab whose session the daemon did not confirm alive', () => {
    // A reattach to a lost session spawns a replacement process, so the plan must decline it.
    expect(plan([tab('a', 'pty-a'), tab('b', 'pty-b')], ['a'], { lostSessions: ['a'] })).toBeNull()
  })
})

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

describe('areTabSessionsConfirmed', () => {
  it('rejects a split tab whose sibling leaf session was not confirmed live', () => {
    expect(areTabSessionsConfirmed(['pty-a', 'pty-b'], new Set(['pty-a']))).toBe(false)
  })

  it('rejects confirmation for a leaf set that changed while the check was pending', () => {
    expect(areTabSessionsConfirmed(['pty-a', 'pty-c'], new Set(['pty-a', 'pty-b']))).toBe(false)
  })

  it('admits a tab only when every leaf session was confirmed', () => {
    expect(areTabSessionsConfirmed(['pty-a', 'pty-b'], new Set(['pty-a', 'pty-b']))).toBe(true)
    expect(areTabSessionsConfirmed([], new Set())).toBe(false)
  })
})

describe('createDeferredNarrowingUndo', () => {
  const narrowing = { allowedTabIds: new Set(['live']), deferredTabIds: new Set(['p1']) }

  it('keeps a released narrowing until the tab cold-park cool-down has passed', () => {
    vi.useFakeTimers()
    try {
      const undo = vi.fn()
      const undos = createDeferredNarrowingUndo({
        delayMs: 31_000,
        undo,
        remainingHoldMs: () => null
      })
      undos.schedule('wt', narrowing)
      vi.advanceTimersByTime(30_000)
      expect(undo).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1_000)
      expect(undo).toHaveBeenCalledWith('wt', narrowing)
    } finally {
      vi.useRealTimers()
    }
  })

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
