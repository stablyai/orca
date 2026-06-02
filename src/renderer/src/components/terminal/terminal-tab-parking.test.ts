import { describe, expect, it } from 'vitest'
import {
  TERMINAL_TAB_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_PARK_DELAY_MS,
  getTerminalTabColdParkRecheckDelayMs,
  selectColdParkedTerminalTabs
} from './terminal-worktree-parking'

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

  it('keeps visible and recent inactive terminal tabs mounted', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        { ...localTab('tab-visible', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS), isVisible: true },
        localTab('tab-recent-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localTab('tab-recent-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1)
      ],
      pendingStartupByTabId: {},
      nowMs,
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set())
  })

  it('cold-parks the oldest inactive local tabs beyond the retain limit', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        localTab('tab-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localTab('tab-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
        localTab('tab-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2)
      ],
      pendingStartupByTabId: {},
      nowMs,
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set(['tab-3']))
  })

  it('cold-parks aged inactive local tabs even when under the retain limit', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [localTab('tab-1', nowMs - TERMINAL_TAB_HOT_RETAIN_MS)],
      pendingStartupByTabId: {},
      nowMs,
      hotRetainLimit: 12
    })

    expect(selected).toEqual(new Set(['tab-1']))
  })

  it('does not cold-park inactive terminal tabs without local snapshot recovery', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        localTab('tab-local', nowMs - TERMINAL_TAB_HOT_RETAIN_MS),
        {
          ...localTab('tab-ssh', nowMs - TERMINAL_TAB_HOT_RETAIN_MS),
          ptyId: 'ssh:ssh-1@@pty-1'
        },
        {
          ...localTab('tab-remote', nowMs - TERMINAL_TAB_HOT_RETAIN_MS),
          ptyId: 'remote:env-1@@terminal-1'
        }
      ],
      pendingStartupByTabId: {},
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set(['tab-local']))
  })

  it('keeps portaled, pending-startup, and pending-activation terminal tabs mounted', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        {
          ...localTab('tab-portal', nowMs - TERMINAL_TAB_HOT_RETAIN_MS),
          hasActivityTerminalPortal: true
        },
        localTab('tab-startup', nowMs - TERMINAL_TAB_HOT_RETAIN_MS),
        {
          ...localTab('tab-activation', nowMs - TERMINAL_TAB_HOT_RETAIN_MS),
          pendingActivationSpawn: true
        }
      ],
      pendingStartupByTabId: { 'tab-startup': { command: 'echo pending' } },
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set())
  })
})

describe('getTerminalTabColdParkRecheckDelayMs', () => {
  it('returns the next terminal-tab cold-park policy deadline', () => {
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        hiddenSinceMs: null,
        nowMs: 1_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(50)
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        hiddenSinceMs: 1_000,
        nowMs: 1_100,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(900)
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        hiddenSinceMs: 1_000,
        nowMs: 2_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })
})
