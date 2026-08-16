import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TERMINAL_WORKTREE_PARK_DELAY_MS } from './terminal-hidden-view-parking'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS,
  hasPendingRetentionSpawnWork,
  isEvictionExemptTerminalPty,
  selectForceParkEvictableTabIds,
  selectRetentionForceParkedTerminalWorktrees,
  type TerminalWorktreeRetentionCandidate
} from './terminal-hidden-worktree-retention'

describe('hasPendingRetentionSpawnWork', () => {
  const remoteTab = {
    id: 'tab-remote',
    ptyId: 'remote:env-1@@terminal-1',
    pendingActivationSpawn: true as const
  }

  it('treats a host-backed paired PTY as settled despite activation residue', () => {
    expect(hasPendingRetentionSpawnWork(remoteTab, {})).toBe(false)
    expect(hasPendingRetentionSpawnWork({ ...remoteTab, pendingActivationSpawn: 2 }, {})).toBe(
      false
    )
  })

  it('preserves real startup work and non-paired activation guards', () => {
    expect(hasPendingRetentionSpawnWork(remoteTab, { [remoteTab.id]: ['echo', 'pending'] })).toBe(
      true
    )
    expect(
      hasPendingRetentionSpawnWork(
        { id: 'tab-local', ptyId: 'pty-local', pendingActivationSpawn: true },
        {}
      )
    ).toBe(true)
    expect(
      hasPendingRetentionSpawnWork(
        { id: 'tab-unbound', ptyId: null, pendingActivationSpawn: true },
        {}
      )
    ).toBe(true)
  })
})

describe('isEvictionExemptTerminalPty', () => {
  const worktreeId = 'repo::/worktree'
  const currentPtyId = `${worktreeId}@@session-1`

  beforeEach(async () => {
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([currentPtyId], async () => [
      { id: currentPtyId, authoritative: true }
    ])
  })
  afterEach(() => clearTerminalProviderSnapshotCapabilities())

  it('exempts only live local ptys a remount could not reattach', () => {
    expect(isEvictionExemptTerminalPty('pty-local-detached', worktreeId)).toBe(true)
    expect(isEvictionExemptTerminalPty('other::wt@@session-1', worktreeId)).toBe(true)
  })

  it('never exempts authoritative, SSH, remote-runtime, or unbound ptys', () => {
    expect(isEvictionExemptTerminalPty(currentPtyId, worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty('ssh:conn-1@@pty-1', worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty('remote:env-1@@t-1', worktreeId)).toBe(false)
    expect(isEvictionExemptTerminalPty(null, worktreeId)).toBe(false)
  })

  it('exempts a preserved daemon without an authoritative snapshot', async () => {
    clearTerminalProviderSnapshotCapabilities()
    await synchronizeTerminalProviderSnapshotCapabilities([currentPtyId], async () => [
      { id: currentPtyId, authoritative: false }
    ])

    expect(isEvictionExemptTerminalPty(currentPtyId, worktreeId)).toBe(true)
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
    // Why limit 2: wt-4 is last-active exempt, wt-3 fills the remaining slot; the two oldest evict.
    expect(
      selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees, retentionLimit: 2 })
    ).toEqual(new Set(['wt-1', 'wt-2']))
  })

  it('force-parks past the TTL even under the limit, sparing a last-active candidate inside it', () => {
    const worktrees = [
      retentionCandidate('wt-old', nowMs - TERMINAL_HIDDEN_WORKTREE_RETENTION_TTL_MS),
      retentionCandidate('wt-recent', nowMs - TERMINAL_WORKTREE_PARK_DELAY_MS)
    ]
    expect(selectRetentionForceParkedTerminalWorktrees({ ...base, worktrees })).toEqual(
      new Set(['wt-old'])
    )
  })

  // Why: the last-active exemption keeps the warm cap's "return is always instant"
  // promise, but carrying it into the eviction clock made "none past 45 minutes"
  // false — a lone hidden un-parkable worktree stayed mounted for the whole session.
  it('force-parks the last-active candidate once it passes the TTL (the exemption bounds the cap, not the clock)', () => {
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
    // Why the recent sibling: it takes the last-active exemption, so the aged
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
