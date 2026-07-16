import { describe, expect, it } from 'vitest'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  TERMINAL_TAB_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_PARK_DELAY_MS,
  canParkTerminalTabRenderer,
  canParkTerminalWorktreeRenderers,
  getTerminalTabColdParkRecheckDelayMs,
  getTerminalWorktreeColdParkRecheckDelayMs,
  isSnapshotBackedTerminalPty,
  selectColdParkedTerminalTabs,
  selectColdParkedTerminalWorktrees
} from './terminal-hidden-view-parking'

describe('isSnapshotBackedTerminalPty', () => {
  it('allows local daemon sessions owned by the worktree', () => {
    expect(isSnapshotBackedTerminalPty('repo::/worktree@@session-1', 'repo::/worktree')).toBe(true)
    expect(isSnapshotBackedTerminalPty('wt-1@@session-1', 'wt-1')).toBe(true)
  })

  // Why: separator-less ids ('1', '2', 'pty-local-detached') come from the
  // daemon-fail-open LocalPtyProvider and have no daemon session model —
  // revealing a parked pane would silently respawn a fresh shell, so they
  // must not count as snapshot-backed (changed from the ported prior art).
  it('rejects separator-less local PTY ids that lack a daemon session model', () => {
    expect(isSnapshotBackedTerminalPty('pty-local-detached', 'repo::/worktree')).toBe(false)
    expect(isSnapshotBackedTerminalPty('1', 'wt-1')).toBe(false)
  })

  it('rejects tabs that do not have a PTY yet', () => {
    expect(isSnapshotBackedTerminalPty(null, 'repo::/worktree')).toBe(false)
  })

  it('rejects daemon sessions owned by another worktree', () => {
    expect(isSnapshotBackedTerminalPty('repo::/other@@session-1', 'repo::/worktree')).toBe(false)
    expect(isSnapshotBackedTerminalPty('wt-2@@session-1', 'wt-1')).toBe(false)
  })

  it('rejects SSH and remote runtime PTY handles', () => {
    expect(isSnapshotBackedTerminalPty('ssh:ssh-1@@pty-1', 'repo::/worktree')).toBe(false)
    expect(isSnapshotBackedTerminalPty('remote:env-1@@terminal-1', 'repo::/worktree')).toBe(false)
  })
})

describe('canParkTerminalWorktreeRenderers', () => {
  const hiddenSinceMs = 1_000
  const nowMs = hiddenSinceMs + TERMINAL_WORKTREE_PARK_DELAY_MS
  const base = {
    worktreeId: 'repo::/worktree',
    terminalTabs: [{ id: 'tab-1', ptyId: 'repo::/worktree@@session-1' }],
    pendingStartupByTabId: {},
    parkingEnabled: true,
    isVisible: false,
    shouldMeasureHiddenWorktree: false,
    hasActivityTerminalPortal: false,
    hiddenSinceMs,
    nowMs
  }

  it('parks hidden local terminal renderers after the idle delay', () => {
    expect(canParkTerminalWorktreeRenderers(base)).toBe(true)
  })

  it('keeps a previously mounted v19 terminal eligible for ordinary parking', () => {
    const legacyPtyId = 'repo::/worktree@@session-1'
    clearTerminalProviderSnapshotCapabilities()
    synchronizeTerminalProviderSnapshotCapabilities([legacyPtyId], (ids) =>
      ids.map((id) => ({ id, authoritative: false }))
    )

    expect(canParkTerminalWorktreeRenderers(base)).toBe(true)
  })

  it('never parks when the settings kill switch disables parking', () => {
    expect(canParkTerminalWorktreeRenderers({ ...base, parkingEnabled: false })).toBe(false)
    expect(
      canParkTerminalWorktreeRenderers({
        ...base,
        parkingEnabled: false,
        nowMs: hiddenSinceMs + TERMINAL_WORKTREE_HOT_RETAIN_MS * 10
      })
    ).toBe(false)
  })

  it('keeps renderers mounted while visible, measuring, portaled, or before the delay', () => {
    expect(canParkTerminalWorktreeRenderers({ ...base, isVisible: true })).toBe(false)
    expect(canParkTerminalWorktreeRenderers({ ...base, shouldMeasureHiddenWorktree: true })).toBe(
      false
    )
    expect(canParkTerminalWorktreeRenderers({ ...base, hasActivityTerminalPortal: true })).toBe(
      false
    )
    expect(
      canParkTerminalWorktreeRenderers({
        ...base,
        nowMs: hiddenSinceMs + TERMINAL_WORKTREE_PARK_DELAY_MS - 1
      })
    ).toBe(false)
  })

  it('honors a per-call cold-park delay override', () => {
    const shortDelayArgs = { ...base, coldParkDelayMs: 100 }
    expect(canParkTerminalWorktreeRenderers({ ...shortDelayArgs, nowMs: hiddenSinceMs + 99 })).toBe(
      false
    )
    expect(
      canParkTerminalWorktreeRenderers({ ...shortDelayArgs, nowMs: hiddenSinceMs + 100 })
    ).toBe(true)
  })

  it('keeps the renderer mounted when any terminal lacks snapshot-backed restore', () => {
    expect(
      canParkTerminalWorktreeRenderers({
        ...base,
        terminalTabs: [
          { id: 'tab-1', ptyId: 'repo::/worktree@@session-1' },
          { id: 'tab-2', ptyId: 'ssh:ssh-1@@pty-1' }
        ]
      })
    ).toBe(false)
  })

  it('keeps renderers mounted while a tab has startup or activation work pending', () => {
    expect(
      canParkTerminalWorktreeRenderers({
        ...base,
        pendingStartupByTabId: { 'tab-1': { command: 'echo pending' } }
      })
    ).toBe(false)
    expect(
      canParkTerminalWorktreeRenderers({
        ...base,
        terminalTabs: [
          { id: 'tab-1', ptyId: 'repo::/worktree@@session-1', pendingActivationSpawn: true }
        ]
      })
    ).toBe(false)
    expect(
      canParkTerminalWorktreeRenderers({
        ...base,
        terminalTabs: [
          { id: 'tab-1', ptyId: 'repo::/worktree@@session-1', pendingActivationSpawn: 2 }
        ]
      })
    ).toBe(false)
  })
})

describe('canParkTerminalTabRenderer', () => {
  const hiddenSinceMs = 1_000
  const base = {
    worktreeId: 'wt-1',
    terminalTab: {
      id: 'tab-1',
      ptyId: 'wt-1@@session-1',
      isVisible: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs
    },
    pendingStartupByTabId: {},
    parkingEnabled: true,
    nowMs: hiddenSinceMs + TERMINAL_WORKTREE_PARK_DELAY_MS
  }

  it('parks an idle hidden local tab and honors the kill switch', () => {
    expect(canParkTerminalTabRenderer(base)).toBe(true)
    expect(canParkTerminalTabRenderer({ ...base, parkingEnabled: false })).toBe(false)
  })

  it('honors a per-call cold-park delay override', () => {
    expect(
      canParkTerminalTabRenderer({ ...base, coldParkDelayMs: 100, nowMs: hiddenSinceMs + 99 })
    ).toBe(false)
    expect(
      canParkTerminalTabRenderer({ ...base, coldParkDelayMs: 100, nowMs: hiddenSinceMs + 100 })
    ).toBe(true)
  })
})

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

  it('keeps recent hidden local worktrees hot up to the retain limit', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
        localCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set())
  })

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
        // Why: wt-recent is the last-active exempt one; wt-1 proves the TTL
        // sweep still parks an aged worktree that is under the cap.
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

  it('exempts only the last-active worktree from the cap, counting it against the limit', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
        localCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
        localCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      // Why: wt-1 (last-active) takes one of the two warm slots, so only wt-2
      // fits the remaining slot and wt-3 parks.
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set(['wt-3']))
  })

  it('selects nothing when the settings kill switch disables parking', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
        localCandidate('wt-1', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
        localCandidate('wt-2', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS * 2)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: false,
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set())
  })

  it('does not cold-park terminals without local snapshot recovery', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
        // Why: wt-recent is last-active (exempt); wt-local proves the aged
        // local worktree still parks while ssh/remote never enter the candidate
        // set at all.
        localCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localCandidate('wt-local', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
        {
          ...localCandidate('wt-ssh', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
          terminalTabs: [{ id: 'tab-ssh', ptyId: 'ssh:ssh-1@@pty-1' }]
        },
        {
          ...localCandidate('wt-remote', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
          terminalTabs: [{ id: 'tab-remote', ptyId: 'remote:env-1@@terminal-1' }]
        }
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set(['wt-local']))
  })

  it('keeps visible, measuring, portaled, and pending terminals mounted', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
        {
          ...localCandidate('wt-visible', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
          isVisible: true
        },
        {
          ...localCandidate('wt-measuring', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
          shouldMeasureHiddenWorktree: true
        },
        {
          ...localCandidate('wt-portal', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
          hasActivityTerminalPortal: true
        },
        {
          ...localCandidate('wt-activation', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS),
          terminalTabs: [
            {
              id: 'tab-activation',
              ptyId: 'wt-activation@@session-1',
              pendingActivationSpawn: true
            }
          ]
        },
        localCandidate('wt-startup', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS)
      ],
      pendingStartupByTabId: { 'tab-wt-startup': { command: 'echo pending' } },
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

  it('keeps visible and recent inactive terminal tabs mounted', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        { ...localTab('tab-visible', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS), isVisible: true },
        localTab('tab-recent-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localTab('tab-recent-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
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
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set(['tab-3']))
  })

  it('cold-parks aged inactive local tabs even when under the retain limit', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        // Why: tab-recent is last-active exempt; tab-1 proves the TTL sweep
        // still parks an aged tab under the cap.
        localTab('tab-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
        localTab('tab-1', nowMs - TERMINAL_TAB_HOT_RETAIN_MS)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 12
    })

    expect(selected).toEqual(new Set(['tab-1']))
  })

  it('never cold-parks the single most-recently-hidden (last-active) tab', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [localTab('tab-1', nowMs - TERMINAL_TAB_HOT_RETAIN_MS)],
      pendingStartupByTabId: {},
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set())
  })

  it('selects nothing when the settings kill switch disables parking', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        localTab('tab-1', nowMs - TERMINAL_TAB_HOT_RETAIN_MS),
        localTab('tab-2', nowMs - TERMINAL_TAB_HOT_RETAIN_MS * 2)
      ],
      pendingStartupByTabId: {},
      parkingEnabled: false,
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set())
  })

  it('does not cold-park inactive terminal tabs without local snapshot recovery', () => {
    const selected = selectColdParkedTerminalTabs({
      worktreeId: 'wt-1',
      terminalTabs: [
        // Why: tab-recent is last-active exempt; tab-local proves the aged
        // local tab still parks while ssh/remote never enter the candidate set.
        localTab('tab-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS),
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
      parkingEnabled: true,
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
      parkingEnabled: true,
      nowMs,
      hotRetainLimit: 0
    })

    expect(selected).toEqual(new Set())
  })
})

describe('getTerminalWorktreeColdParkRecheckDelayMs', () => {
  it('returns the next cold-park policy deadline', () => {
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: null,
        nowMs: 1_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(50)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_100,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(900)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })

  it('schedules no recheck when the settings kill switch disables parking', () => {
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        parkingEnabled: false,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })
})

describe('getTerminalTabColdParkRecheckDelayMs', () => {
  it('returns the next terminal-tab cold-park policy deadline', () => {
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: null,
        nowMs: 1_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(50)
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 1_100,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(900)
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: true,
        hiddenSinceMs: 1_000,
        nowMs: 2_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })

  it('schedules no recheck when the settings kill switch disables parking', () => {
    expect(
      getTerminalTabColdParkRecheckDelayMs({
        parkingEnabled: false,
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })
})
