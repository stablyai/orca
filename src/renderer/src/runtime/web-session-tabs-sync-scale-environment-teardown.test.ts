import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  acceptReplayedWebSessionTabsSnapshot,
  clearWebSessionTabsTrackingForEnvironment,
  decideWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import {
  beginWebSessionTabsSnapshotRecovery,
  recordAcceptedWebSessionTabsEnvironment,
  recordReceivedWebSessionTabsRemoval,
  recordReceivedWebSessionTabsSnapshot,
  rememberHostTerminalTabCount,
  trackWebSessionTabsWorktree
} from './web-session-tabs-sync/tracking'
import { confirmTrackedWebSessionTabsInventoryAbsence } from './web-session-tabs-sync/session-tabs-inventory-absence'
import {
  latestSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsRemovalFenceByWorktree,
  lastHostTerminalTabCountByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  sessionTabsEnvironmentsByWorktree,
  sessionTabsInventoryOmissionsByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRecoveryStateByWorktree,
  trackedSessionTabsWorktreeIdsByEnvironment
} from './web-session-tabs-sync/state'
import { _getSessionTabsEnvironmentKeyIndexCountsForTest } from './web-session-tabs-sync/session-tabs-environment-key-index'

vi.mock('../store', () => ({
  useAppStore: { setState: vi.fn(), getState: vi.fn(() => ({})) }
}))
vi.mock('./web-session-terminal-handle-events', () => ({
  queueAcceptedWebSessionTerminalSnapshot: vi.fn()
}))

const ENVIRONMENTS = 20
const WORKTREES = 50

function envId(index: number): string {
  return `env-${String(index).padStart(4, '0')}`
}
function worktreeId(index: number): string {
  return `repo::/Users/x/orca/worktrees/workspace-${String(index).padStart(4, '0')}`
}

function snapshotFor(worktree: string, version: number): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: `epoch-${version}`,
    snapshotVersion: version,
    tabs: [{ type: 'terminal', id: 'tab-1' }],
    groups: [],
    tabBarOrder: [],
    activeTabId: null
  } as unknown as RuntimeMobileSessionTabsResult
}

/** Populates every per-worktree map through the paths that maintain the key index. */
function populate(environments: number, worktrees: number): void {
  resetWebSessionTabsSnapshotFreshnessForTests()
  for (let e = 0; e < environments; e += 1) {
    const environmentId = envId(e)
    for (let w = 0; w < worktrees; w += 1) {
      const worktree = worktreeId(w)
      const snapshot = snapshotFor(worktree, 1)
      const frame = recordReceivedWebSessionTabsSnapshot(environmentId, snapshot)
      decideWebSessionTabsSnapshot(snapshot, environmentId)
      trackWebSessionTabsWorktree(environmentId, worktree)
      rememberHostTerminalTabCount(environmentId, snapshot)
      recordAcceptedWebSessionTabsEnvironment(environmentId, snapshot)
      beginWebSessionTabsSnapshotRecovery(environmentId, worktree, frame)
      confirmTrackedWebSessionTabsInventoryAbsence(environmentId, {
        worktree,
        freshness: { publicationEpoch: 'epoch-1', snapshotVersion: 1 }
      })
    }
  }
}

/** Every map an environment teardown must reach without enumerating it. */
const SWEPT_MAPS = [
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  latestSessionTabsRemovalFenceByWorktree,
  sessionTabsRecoveryStateByWorktree,
  lastHostTerminalTabCountByWorktree,
  sessionTabsInventoryOmissionsByWorktree,
  sessionTabsEnvironmentsByWorktree
]

function keysForEnvironment(environmentId: string): number {
  let count = 0
  for (const map of [
    latestSessionTabsSnapshotByWorktree,
    latestReceivedSessionTabsSnapshotByWorktree,
    sessionTabsPublicationEpochHistoryByWorktree,
    sessionTabsRecoveryStateByWorktree,
    lastHostTerminalTabCountByWorktree,
    sessionTabsInventoryOmissionsByWorktree
  ]) {
    for (const key of map.keys()) {
      if (key.startsWith(`${environmentId}:`)) {
        count += 1
      }
    }
  }
  return count
}

function environmentsNamingWorktrees(environmentId: string): number {
  let count = 0
  for (const environments of sessionTabsEnvironmentsByWorktree.values()) {
    if (environments.has(environmentId)) {
      count += 1
    }
  }
  return count
}

describe('clearWebSessionTabsTrackingForEnvironment at workspace scale', () => {
  beforeEach(resetWebSessionTabsSnapshotFreshnessForTests)

  it('drains only the torn-down environment across every per-worktree map', () => {
    populate(ENVIRONMENTS, WORKTREES)
    const victim = envId(0)
    const bystander = envId(1)
    expect(keysForEnvironment(victim)).toBeGreaterThan(0)
    const bystanderKeysBefore = keysForEnvironment(bystander)

    clearWebSessionTabsTrackingForEnvironment(victim)

    expect(keysForEnvironment(victim)).toBe(0)
    expect(environmentsNamingWorktrees(victim)).toBe(0)
    expect(trackedSessionTabsWorktreeIdsByEnvironment.has(victim)).toBe(false)
    expect(keysForEnvironment(bystander)).toBe(bystanderKeysBefore)
    expect(environmentsNamingWorktrees(bystander)).toBe(WORKTREES)
  })

  it('drains the environment key index that makes teardown linear', () => {
    populate(ENVIRONMENTS, WORKTREES)
    expect(_getSessionTabsEnvironmentKeyIndexCountsForTest()).toEqual({
      environments: ENVIRONMENTS,
      worktrees: ENVIRONMENTS * WORKTREES
    })

    for (let e = 0; e < ENVIRONMENTS; e += 1) {
      clearWebSessionTabsTrackingForEnvironment(envId(e))
    }

    expect(_getSessionTabsEnvironmentKeyIndexCountsForTest()).toEqual({
      environments: 0,
      worktrees: 0
    })
  })

  it('never enumerates a per-worktree map, so teardown cost tracks one environment', () => {
    populate(ENVIRONMENTS, WORKTREES)
    // Why: a wall clock cannot separate linear from quadratic on a loaded box.
    // Enumerating any of these maps is the sweep itself, so count that instead.
    const enumerations = SWEPT_MAPS.map((map) => vi.spyOn(map, 'keys'))

    clearWebSessionTabsTrackingForEnvironment(envId(0))

    for (const enumeration of enumerations) {
      expect(enumeration).not.toHaveBeenCalled()
      enumeration.mockRestore()
    }
    expect(keysForEnvironment(envId(0))).toBe(0)
  })
})

/**
 * Every write path must register the key index, or teardown silently strands
 * that map's entries. Each case populates through exactly one path.
 */
const WRITE_PATHS: readonly {
  name: string
  write: (environmentId: string, worktree: string) => void
  size: () => number
}[] = [
  {
    name: 'received snapshot',
    write: (environmentId, worktree) => {
      recordReceivedWebSessionTabsSnapshot(environmentId, snapshotFor(worktree, 1))
    },
    size: () => latestReceivedSessionTabsSnapshotByWorktree.size
  },
  {
    name: 'publication epoch tombstone',
    write: (environmentId, worktree) => {
      recordReceivedWebSessionTabsSnapshot(environmentId, snapshotFor(worktree, 1))
    },
    size: () => sessionTabsPublicationEpochHistoryByWorktree.size
  },
  {
    name: 'accepted snapshot',
    write: (environmentId, worktree) => {
      decideWebSessionTabsSnapshot(snapshotFor(worktree, 1), environmentId)
    },
    size: () => latestSessionTabsSnapshotByWorktree.size
  },
  {
    name: 'replayed snapshot',
    write: (environmentId, worktree) => {
      decideWebSessionTabsSnapshot(snapshotFor(worktree, 1), environmentId)
      acceptReplayedWebSessionTabsSnapshot(environmentId, worktree)
    },
    size: () => replayableSessionTabsSnapshotByWorktree.size
  },
  {
    name: 'pending recovery',
    write: (environmentId, worktree) => {
      beginWebSessionTabsSnapshotRecovery(environmentId, worktree, 1)
    },
    size: () => sessionTabsRecoveryStateByWorktree.size
  },
  {
    name: 'removal fence',
    write: (environmentId, worktree) => {
      beginWebSessionTabsSnapshotRecovery(environmentId, worktree, 1)
      recordReceivedWebSessionTabsRemoval(environmentId, worktree, 2)
    },
    size: () => latestSessionTabsRemovalFenceByWorktree.size
  },
  {
    name: 'host terminal tab count',
    write: (environmentId, worktree) => {
      rememberHostTerminalTabCount(environmentId, snapshotFor(worktree, 1))
    },
    size: () => lastHostTerminalTabCountByWorktree.size
  },
  {
    name: 'inventory omission',
    write: (environmentId, worktree) => {
      confirmTrackedWebSessionTabsInventoryAbsence(environmentId, {
        worktree,
        freshness: { publicationEpoch: 'epoch-1', snapshotVersion: 1 }
      })
    },
    size: () => sessionTabsInventoryOmissionsByWorktree.size
  },
  {
    name: 'accepted environment',
    write: (environmentId, worktree) => {
      recordAcceptedWebSessionTabsEnvironment(environmentId, snapshotFor(worktree, 1))
    },
    size: () => sessionTabsEnvironmentsByWorktree.size
  }
]

describe.each(WRITE_PATHS)('teardown after a $name write', ({ write, size }) => {
  it('leaves nothing behind', () => {
    resetWebSessionTabsSnapshotFreshnessForTests()
    for (let w = 0; w < WORKTREES; w += 1) {
      write(envId(0), worktreeId(w))
    }
    expect(size()).toBeGreaterThan(0)

    clearWebSessionTabsTrackingForEnvironment(envId(0))

    expect(size()).toBe(0)
    expect(_getSessionTabsEnvironmentKeyIndexCountsForTest().worktrees).toBe(0)
  })
})
