import { describe, expect, it } from 'vitest'
import {
  TERMINAL_WORKTREE_HOT_RETAIN_MS,
  TERMINAL_WORKTREE_PARK_DELAY_MS,
  canParkTerminalWorktreeRenderers,
  getTerminalWorktreeColdParkRecheckDelayMs,
  selectColdParkedTerminalWorktrees,
  isSnapshotBackedTerminalPty
} from './terminal-worktree-parking'

describe('isSnapshotBackedTerminalPty', () => {
  it('allows local daemon sessions owned by the worktree', () => {
    expect(isSnapshotBackedTerminalPty('repo::/worktree@@session-1', 'repo::/worktree')).toBe(true)
    expect(isSnapshotBackedTerminalPty('wt-1@@session-1', 'wt-1')).toBe(true)
  })

  it('allows legacy local PTY IDs that reattach through the local session path', () => {
    expect(isSnapshotBackedTerminalPty('pty-local-detached', 'repo::/worktree')).toBe(true)
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

  it('parks hidden local terminal renderers after the idle delay', () => {
    expect(
      canParkTerminalWorktreeRenderers({
        worktreeId: 'repo::/worktree',
        terminalTabs: [{ id: 'tab-1', ptyId: 'repo::/worktree@@session-1' }],
        pendingStartupByTabId: {},
        isVisible: false,
        shouldMeasureHiddenWorktree: false,
        hasActivityTerminalPortal: false,
        hiddenSinceMs,
        nowMs
      })
    ).toBe(true)
  })

  it('keeps renderers mounted while visible, measuring, portaled, or before the delay', () => {
    const base = {
      worktreeId: 'repo::/worktree',
      terminalTabs: [{ id: 'tab-1', ptyId: 'repo::/worktree@@session-1' }],
      pendingStartupByTabId: {},
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs,
      nowMs
    }

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

  it('keeps the renderer mounted when any terminal lacks snapshot-backed restore', () => {
    expect(
      canParkTerminalWorktreeRenderers({
        worktreeId: 'repo::/worktree',
        terminalTabs: [
          { id: 'tab-1', ptyId: 'repo::/worktree@@session-1' },
          { id: 'tab-2', ptyId: 'ssh:ssh-1@@pty-1' }
        ],
        pendingStartupByTabId: {},
        isVisible: false,
        shouldMeasureHiddenWorktree: false,
        hasActivityTerminalPortal: false,
        hiddenSinceMs,
        nowMs
      })
    ).toBe(false)
  })

  it('keeps renderers mounted while a tab has startup or activation work pending', () => {
    const base = {
      worktreeId: 'repo::/worktree',
      terminalTabs: [{ id: 'tab-1', ptyId: 'repo::/worktree@@session-1' }],
      pendingStartupByTabId: {},
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      hiddenSinceMs,
      nowMs
    }

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
      nowMs,
      hotRetainLimit: 2
    })

    expect(selected).toEqual(new Set(['wt-3']))
  })

  it('cold-parks aged local worktrees even when under the retain limit', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [localCandidate('wt-1', nowMs - TERMINAL_WORKTREE_HOT_RETAIN_MS)],
      pendingStartupByTabId: {},
      nowMs,
      hotRetainLimit: 4
    })

    expect(selected).toEqual(new Set(['wt-1']))
  })

  it('does not cold-park terminals without local snapshot recovery', () => {
    const selected = selectColdParkedTerminalWorktrees({
      worktrees: [
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
        hiddenSinceMs: null,
        nowMs: 1_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        hiddenSinceMs: 1_000,
        nowMs: 1_050,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(50)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        hiddenSinceMs: 1_000,
        nowMs: 1_100,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBe(900)
    expect(
      getTerminalWorktreeColdParkRecheckDelayMs({
        hiddenSinceMs: 1_000,
        nowMs: 2_000,
        coldParkDelayMs: 100,
        hotRetainMs: 1_000
      })
    ).toBeNull()
  })
})
