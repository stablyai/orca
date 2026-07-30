import { describe, expect, it } from 'vitest'
import { TERMINAL_WORKTREE_PARK_DELAY_MS } from './terminal-hidden-view-parking'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  countTerminalLayoutPanes,
  getTerminalHiddenPaneRetentionWeight,
  isEvictionExemptTerminalPty,
  selectForceParkEvictableTabIds,
  selectRetentionForceParkedTerminalWorktrees,
  selectTerminalLayoutPaneCountByTabId,
  type TerminalWorktreeRetentionCandidate
} from './terminal-hidden-worktree-retention'

describe('isEvictionExemptTerminalPty', () => {
  const worktreeId = 'repo::/worktree'

  it('exempts only live local ptys a remount could not reattach', () => {
    expect(isEvictionExemptTerminalPty('pty-local-detached', worktreeId)).toBe(true)
    expect(isEvictionExemptTerminalPty('other::wt@@session-1', worktreeId)).toBe(true)
  })

  it('never exempts snapshot-backed, SSH, remote-runtime, or unbound ptys', () => {
    expect(isEvictionExemptTerminalPty(`${worktreeId}@@session-1`, worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty('ssh:conn-1@@pty-1', worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty('remote:env-1@@t-1', worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty(null, worktreeId)).toBe(false)
  })
})

describe('selectRetentionForceParkedTerminalWorktrees', () => {
  const nowMs = 5_000_000

  function retentionCandidate(
    worktreeId: string,
    hiddenSinceMs: number | null,
    partial: Partial<TerminalWorktreeRetentionCandidate> = {}
  ): TerminalWorktreeRetentionCandidate {
    return {
      worktreeId,
      hiddenSinceMs,
      isVisible: false,
      shouldMeasureHiddenWorktree: false,
      hasActivityTerminalPortal: false,
      ordinaryParkingCovers: false,
      hasPendingSpawnWork: false,
      retainedPaneCount: 1,
      ...partial
    }
  }

  const base = {
    parkingEnabled: true,
    retentionBudgetEnabled: true,
    nowMs
  }

  it('returns empty when either kill switch is off', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS)
    ]
    expect(
      selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees, parkingEnabled: false })
    ).toEqual(new Set())
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionBudgetEnabled: false
      })
    ).toEqual(new Set())
  })

  it('force-parks the least-recently-hidden candidates beyond the retention limit', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 3),
      retentionCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2),
      retentionCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
      retentionCandidate('wt-4', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    // Why limit 2: newest wt-4 claims one unit, wt-3 claims the other; the two oldest evict.
    expect(
      selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees, retentionLimit: 2 })
    ).toEqual(new Set(['wt-1', 'wt-2']))
  })

  it('force-parks a newest candidate that exceeds the pane budget by itself', () => {
    const worktrees = [
      retentionCandidate('wt-many-panes', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS, {
        retainedPaneCount: 13
      })
    ]

    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(
      new Set(['wt-many-panes'])
    )
  })

  it('does not let empty retained topology bypass the pane budget', () => {
    const worktrees = [
      retentionCandidate('wt-empty-topology', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS, {
        retainedPaneCount: 0
      })
    ]

    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionLimit: 0
      })
    ).toEqual(new Set(['wt-empty-topology']))
  })

  it('spends the budget on the newest weighted worktrees first', () => {
    const worktrees = [
      retentionCandidate('wt-old-small', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2, {
        retainedPaneCount: 2
      }),
      retentionCandidate('wt-middle', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1, {
        retainedPaneCount: 3
      }),
      retentionCandidate('wt-new', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS, {
        retainedPaneCount: 4
      })
    ]

    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionLimit: 6
      })
    ).toEqual(new Set(['wt-middle']))
  })

  it('weights high-scrollback panes against the same renderer budget', () => {
    const worktrees = [
      retentionCandidate('wt-old', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
      retentionCandidate('wt-new', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]

    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        scrollbackRows: 50_000
      })
    ).toEqual(new Set(['wt-old']))
  })

  it('force-parks past the TTL even under the limit while retaining a newer candidate', () => {
    const worktrees = [
      retentionCandidate('wt-old', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS),
      retentionCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(
      new Set(['wt-old'])
    )
  })

  // Why: capacity never overrides the absolute clock; otherwise a lone hidden
  // un-parkable worktree could stay mounted for the whole session.
  it('force-parks the newest candidate once it passes the TTL', () => {
    const lone = [retentionCandidate('wt-lone', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS)]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees: lone })).toEqual(
      new Set(['wt-lone'])
    )
    const insideTtl = [
      retentionCandidate('wt-lone', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS + 1)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees: insideTtl })).toEqual(
      new Set()
    )
  })

  it('never force-parks visible, measuring, portaled, covered, pending, or fresh candidates', () => {
    const aged = nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
    const worktrees = [
      retentionCandidate('wt-visible', aged, { isVisible: true }),
      retentionCandidate('wt-measure', aged, { shouldMeasureHiddenWorktree: true }),
      retentionCandidate('wt-portal', aged, { hasActivityTerminalPortal: true }),
      retentionCandidate('wt-covered', aged, { ordinaryParkingCovers: true }),
      retentionCandidate('wt-pending', aged, { hasPendingSpawnWork: true }),
      retentionCandidate('wt-fresh', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS + 1),
      retentionCandidate('wt-unhidden', null)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(new Set())
  })

  // Why: hiddenSince (and with it TTL ranking) survives a measure window, so
  // without the cool-down veto a measured past-TTL worktree would force-park
  // again the instant the lease ends — the remount/reattach thrash Bug #2.
  it('holds a candidate out of force-park until its post-measure cool-down ends', () => {
    const aged = nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS
    // Why the recent sibling: it claims the only capacity, so the aged
    // candidate's verdict is decided by the cool-down alone.
    const recent = retentionCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees: [
          retentionCandidate('wt-measured', aged, { parkCooldownUntilMs: nowMs + 1 }),
          recent
        ]
      })
    ).toEqual(new Set())
    expect(
      selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees: [retentionCandidate('wt-measured', aged, { parkCooldownUntilMs: nowMs }), recent]
      })
    ).toEqual(new Set(['wt-measured']))
  })

  it('is idempotent and only grows as time advances (flip-loop dwell)', () => {
    const worktrees = [
      retentionCandidate('wt-1', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 3),
      retentionCandidate('wt-2', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 2),
      retentionCandidate('wt-3', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS - 1),
      retentionCandidate('wt-4', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    const first = selectRetentionForceParkedTerminalWorktrees({
      ...base,
      worktrees,
      retentionLimit: 2
    })
    const second = selectRetentionForceParkedTerminalWorktrees({
      ...base,
      worktrees,
      retentionLimit: 2
    })
    expect(second).toEqual(first)
    // Why: with unchanged inputs, a later evaluation may only ADD members —
    // a verdict that oscillates with time is the React-#185 ingredient.
    for (const laterMs of [nowMs + 1_000, nowMs + TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS]) {
      const later = selectRetentionForceParkedTerminalWorktrees({
        ...base,
        worktrees,
        retentionLimit: 2,
        nowMs: laterMs
      })
      for (const id of first) {
        expect(later.has(id)).toBe(true)
      }
    }
  })
})

describe('terminal hidden pane retention weight', () => {
  it('counts split leaves, PTY-only rootless layouts, and a fresh one-pane layout', () => {
    expect(
      countTerminalLayoutPanes({
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: 'leaf-1' },
          second: { type: 'leaf', leafId: 'leaf-2' }
        },
        activeLeafId: 'leaf-1',
        expandedLeafId: null
      })
    ).toBe(2)
    expect(
      countTerminalLayoutPanes({
        root: null,
        activeLeafId: null,
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-1': 'pty-1', 'leaf-2': 'pty-2', 'leaf-3': 'pty-3' }
      })
    ).toBe(3)
    expect(countTerminalLayoutPanes(undefined)).toBe(1)
  })

  it('scales pane weight by configured scrollback rows', () => {
    expect(getTerminalHiddenPaneRetentionWeight(3, 5_000)).toBe(3)
    expect(getTerminalHiddenPaneRetentionWeight(3, 25_000)).toBe(15)
    expect(getTerminalHiddenPaneRetentionWeight(2, 50_000)).toBe(20)
  })

  it('charges one pane when retained topology is empty or invalid', () => {
    expect(getTerminalHiddenPaneRetentionWeight(0, 5_000)).toBe(1)
    expect(getTerminalHiddenPaneRetentionWeight(-1, 5_000)).toBe(1)
    expect(getTerminalHiddenPaneRetentionWeight(0.5, 5_000)).toBe(1)
    expect(getTerminalHiddenPaneRetentionWeight(Number.NaN, 5_000)).toBe(1)
  })

  it('reuses pane counts across unrelated store writes and buffer-only layout changes', () => {
    const root = { type: 'leaf' as const, leafId: 'leaf-1' }
    const terminalLayoutsByTabId = {
      'tab-1': { root, activeLeafId: 'leaf-1', expandedLeafId: null }
    }
    const first = selectTerminalLayoutPaneCountByTabId({ terminalLayoutsByTabId })

    expect(selectTerminalLayoutPaneCountByTabId({ terminalLayoutsByTabId })).toBe(first)
    expect(
      selectTerminalLayoutPaneCountByTabId({
        terminalLayoutsByTabId: {
          'tab-1': {
            root,
            activeLeafId: 'leaf-1',
            expandedLeafId: null,
            buffersByLeafId: { 'leaf-1': 'updated buffer' }
          }
        }
      })
    ).toBe(first)

    const changed = selectTerminalLayoutPaneCountByTabId({
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: root,
            second: { type: 'leaf', leafId: 'leaf-2' }
          },
          activeLeafId: 'leaf-1',
          expandedLeafId: null
        }
      }
    })
    expect(changed).not.toBe(first)
    expect(changed).toEqual({ 'tab-1': 2 })
  })
})

describe('selectForceParkEvictableTabIds', () => {
  const tabs = [{ id: 'tab-exempt' }, { id: 'tab-evictable' }]

  it('drops eviction-exempt tabs from the capture and unmount set', () => {
    expect(selectForceParkEvictableTabIds(tabs, (tab) => tab.id === 'tab-exempt')).toEqual([
      'tab-evictable'
    ])
  })

  // Why: an all-exempt worktree still reports as force-parked while freeing nothing —
  // the degenerate case a fleet-wide daemon fail-open produces, which the host logs.
  it('yields nothing when every tab is exempt', () => {
    expect(selectForceParkEvictableTabIds(tabs, () => true)).toEqual([])
  })
})
