/**
 * Gate: the hidden-worktree retention budget must bound mounted tabs once the
 * daemon recovers.
 *
 * Models the field shape: a capability outage settles every local pty
 * unknown, the daemon then recovers, and the session keeps accumulating
 * hidden worktrees. If the settled verdicts are permanent, every tab stays
 * eviction-exempt, force-park frees nothing, and retained mounted tabs grow
 * linearly with visited worktrees — unbounded mounts by design.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import {
  TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT,
  isEvictionExemptTerminalPty,
  selectForceParkEvictableTabIds,
  selectRetentionForceParkedTerminalWorktrees
} from './terminal-hidden-worktree-retention'
import {
  clearTerminalProviderSnapshotCapabilities,
  synchronizeTerminalProviderSnapshotCapabilities
} from '../terminal/terminal-provider-snapshot-capability'

const WORKTREE_COUNT = 8
const TABS_PER_WORKTREE = 2

type GrowthTab = { id: string; ptyId: string }

function worktreeId(index: number): string {
  return `wt-growth-${index}`
}

function worktreeTabs(index: number): GrowthTab[] {
  return Array.from({ length: TABS_PER_WORKTREE }, (_, tabIndex) => ({
    id: `tab-${index}-${tabIndex}`,
    ptyId: `${worktreeId(index)}${PTY_SESSION_ID_SEPARATOR}session-${tabIndex}`
  }))
}

function allPtyIds(): string[] {
  const ids: string[] = []
  for (let index = 0; index < WORKTREE_COUNT; index += 1) {
    for (const tab of worktreeTabs(index)) {
      ids.push(tab.ptyId)
    }
  }
  return ids
}

async function settleCapabilityOutage(startMs: number): Promise<number> {
  const failingResolver = vi.fn(async () => {
    throw new Error('daemon unavailable')
  })
  const livePtyIds = allPtyIds()
  let nowMs = startMs
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const retryDelayMs = await synchronizeTerminalProviderSnapshotCapabilities(
      livePtyIds,
      failingResolver,
      nowMs
    )
    if (retryDelayMs === null) {
      break
    }
    nowMs += retryDelayMs + 1
  }
  return nowMs
}

describe('hidden-worktree retention with recovered capability', () => {
  beforeEach(() => clearTerminalProviderSnapshotCapabilities())

  it('bounds retained mounted tabs at the retention limit as hidden worktrees grow', async () => {
    const settledAtMs = await settleCapabilityOutage(1_000)

    // Daemon recovered well before the retention deadlines fire.
    const healthyResolver = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, authoritative: true }))
    )
    const recoveredAtMs = settledAtMs + 10 * 60_000
    await synchronizeTerminalProviderSnapshotCapabilities(
      allPtyIds(),
      healthyResolver,
      recoveredAtMs
    )
    await synchronizeTerminalProviderSnapshotCapabilities(
      allPtyIds(),
      healthyResolver,
      recoveredAtMs + 10 * 60_000
    )

    // Every worktree hidden for 20+ minutes: all are past the 15-minute TTL.
    const nowMs = recoveredAtMs + 30 * 60_000
    const hiddenSinceMs = nowMs - 20 * 60_000
    const forceParked = selectRetentionForceParkedTerminalWorktrees({
      worktrees: Array.from({ length: WORKTREE_COUNT }, (_, index) => ({
        worktreeId: worktreeId(index),
        hiddenSinceMs,
        isVisible: false,
        shouldMeasureHiddenWorktree: false,
        hasActivityTerminalPortal: false,
        ordinaryParkingCovers: false,
        hasPendingSpawnWork: false
      })),
      parkingEnabled: true,
      retentionBudgetEnabled: true,
      nowMs
    })
    expect(forceParked.size).toBe(WORKTREE_COUNT)

    let retainedMountedTabs = 0
    for (let index = 0; index < WORKTREE_COUNT; index += 1) {
      const tabs = worktreeTabs(index)
      if (!forceParked.has(worktreeId(index))) {
        retainedMountedTabs += tabs.length
        continue
      }
      const evictable = new Set(
        selectForceParkEvictableTabIds(tabs, (tab) =>
          isEvictionExemptTerminalPty(tab.ptyId, worktreeId(index))
        )
      )
      retainedMountedTabs += tabs.length - evictable.size
    }

    // The invariant a bounded system must hold; permanent settle-false keeps
    // every tab exempt and retained grows linearly with visited worktrees.
    expect(retainedMountedTabs).toBeLessThanOrEqual(
      TERMINAL_HIDDEN_WORKTREE_RETENTION_LIMIT * TABS_PER_WORKTREE
    )
  })
})
