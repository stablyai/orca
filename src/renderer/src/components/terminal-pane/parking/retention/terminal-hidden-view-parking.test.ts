import { describe, expect, it } from 'vitest'
import {
  TERMINAL_TAB_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_PARK_DELAY_MS,
  selectColdParkedTerminalTabs,
  selectColdParkedTerminalWorktrees
} from './terminal-hidden-view-parking'

describe('selectColdParkedTerminalWorktrees', () => {
  const nowMs = 500_000

  function localCandidate(worktreeId: string, hiddenSinceMs: number) {
    return {
      worktreeId,
      terminalTabs: [{ id: `tab-${worktreeId}`, ptyId: `${worktreeId}@@session-1` }],
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs
    }
  }

  it('cold-parks the oldest hidden local worktrees beyond the retain limit', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
        localCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
        localCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set(['wt-3']))
  })

  it('cold-parks aged local worktrees even when under the retain limit', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
        // wt-recent takes last-active exemption; wt-1 proves TTL still parks aged candidates below the cap.
        localCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localCandidate('wt-1', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 4
    })

    expect(selected).toEqual(new Set(['wt-1']))
  })

  it('never cold-parks the single most-recently-hidden (last-active) worktree', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [localCandidate('wt-1', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS)],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set())
  })
})

describe('selectColdParkedTerminalTabs', () => {
  const nowMs = 500_000

  function localTab(id: string, hiddenSinceMs: number) {
    return {
      id,
      ptyId: `wt-1@@session-${id}`,
      pendingActivationSpawn: false,
      isVisible: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs
    }
  }

  // Why: view switches stamp every tab together, so UUID order cannot express recency.
  it('resolves an identical-hiddenSinceMs tie by activation order, not by tab id', () => {
    const hiddenSinceMs = nowMs - TERMINAL_TAB_HOT_RETAIN_MS
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        { ...localTab('tab-aaa', hiddenSinceMs), lastActivatedSeq: 1 },
        { ...localTab('tab-zzz', hiddenSinceMs), lastActivatedSeq: 2 }
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set(['tab-aaa']))
  })

  // Why: the cap and exemption must share one recency ranking.
  it('keeps the most recently activated tab warm when the cap evicts a tie', () => {
    const hiddenSinceMs = nowMs - TERMINAL_TAB_HOT_RETAIN_MS + 1
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        { ...localTab('tab-aaa', hiddenSinceMs), lastActivatedSeq: 1 },
        { ...localTab('tab-bbb', hiddenSinceMs), lastActivatedSeq: 3 },
        { ...localTab('tab-ccc', hiddenSinceMs), lastActivatedSeq: 2 }
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set(['tab-aaa']))
  })
})
