import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  decideWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import { clearWebSessionTabsTrackingForWorktree } from './web-session-tabs-sync/tracking-lifecycle'
import { recordReceivedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking'
import {
  MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY,
  lastHostTerminalTabCountByWorktree,
  latestReceivedSessionTabsSnapshotByWorktree,
  latestSessionTabsSnapshotByWorktree,
  replayableSessionTabsSnapshotByWorktree,
  sessionTabsInventoryOmissionsByWorktree,
  sessionTabsPublicationEpochHistoryByWorktree,
  sessionTabsRuntimeHistoryByEnvironment
} from './web-session-tabs-sync/state'
import { _getSessionTabsEnvironmentKeyIndexCountsForTest } from './web-session-tabs-sync/session-tabs-environment-key-index'

vi.mock('../store', () => ({
  useAppStore: { setState: vi.fn(), getState: vi.fn(() => ({})) }
}))
vi.mock('./web-session-terminal-handle-events', () => ({
  queueAcceptedWebSessionTerminalSnapshot: vi.fn()
}))

const ENV = 'env-long-running'
const CYCLES = 10_000

function snapshotFor(worktree: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: `epoch-${worktree}`,
    snapshotVersion: 1,
    tabs: [],
    groups: [],
    tabBarOrder: [],
    activeTabId: null
  } as unknown as RuntimeMobileSessionTabsResult
}

/** Each cycle is one worktree observed then removed by the host, as a long session does for days. */
function driveWorktreeLifecycles(cycles: number): void {
  for (let i = 0; i < cycles; i += 1) {
    const worktree = `repo::/w/${i}`
    recordReceivedWebSessionTabsSnapshot(ENV, snapshotFor(worktree), undefined, `runtime-${i}`)
    clearWebSessionTabsTrackingForWorktree(ENV, worktree)
  }
}

describe('long-running session growth of session-tabs tracking maps', () => {
  beforeEach(resetWebSessionTabsSnapshotFreshnessForTests)

  it('bounds the publication epoch tombstone history across 10k worktree lifecycles', () => {
    driveWorktreeLifecycles(CYCLES)

    expect(sessionTabsPublicationEpochHistoryByWorktree.size).toBe(
      MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY
    )
    expect(MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY).toBeLessThanOrEqual(1024)
    // Why: the tombstone is the only map a worktree removal deliberately retains.
    expect(latestSessionTabsSnapshotByWorktree.size).toBe(0)
    expect(replayableSessionTabsSnapshotByWorktree.size).toBe(0)
    expect(latestReceivedSessionTabsSnapshotByWorktree.size).toBe(0)
    expect(lastHostTerminalTabCountByWorktree.size).toBe(0)
    expect(sessionTabsInventoryOmissionsByWorktree.size).toBe(0)
  })

  it('evicts the key index alongside the tombstone it was retained for', () => {
    driveWorktreeLifecycles(CYCLES)

    expect(_getSessionTabsEnvironmentKeyIndexCountsForTest().worktrees).toBe(
      MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY
    )
  })

  it('retains only the newest tombstones, so a just-removed worktree stays fenced', () => {
    driveWorktreeLifecycles(CYCLES)

    expect(sessionTabsPublicationEpochHistoryByWorktree.has(`${ENV}:repo::/w/${CYCLES - 1}`)).toBe(
      true
    )
    expect(sessionTabsPublicationEpochHistoryByWorktree.has(`${ENV}:repo::/w/0`)).toBe(false)
  })

  it('keeps a still-publishing worktree fenced while removed neighbours churn past the cap', () => {
    const live = 'repo::/w/live'
    const liveFrame = (version: number): RuntimeMobileSessionTabsResult => ({
      ...snapshotFor(live),
      publicationEpoch: 'epoch-live',
      snapshotVersion: version
    })
    // Fill to the cap with the live worktree noted first, so it is the oldest insert.
    decideWebSessionTabsSnapshot(liveFrame(1), ENV)
    for (let i = 0; i < MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY - 1; i += 1) {
      const worktree = `repo::/w/churn-${i}`
      recordReceivedWebSessionTabsSnapshot(ENV, snapshotFor(worktree))
      clearWebSessionTabsTrackingForWorktree(ENV, worktree)
    }
    expect(sessionTabsPublicationEpochHistoryByWorktree.size).toBe(
      MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY
    )

    // Why: a live frame must move the entry off the eviction front, or the next
    // removed worktree evicts a worktree that is still publishing.
    decideWebSessionTabsSnapshot(liveFrame(2), ENV)
    recordReceivedWebSessionTabsSnapshot(ENV, snapshotFor('repo::/w/churn-overflow'))

    expect(sessionTabsPublicationEpochHistoryByWorktree.has(`${ENV}:${live}`)).toBe(true)
    expect(sessionTabsPublicationEpochHistoryByWorktree.has(`${ENV}:repo::/w/churn-0`)).toBe(false)
  })

  it('bounds the retired runtime-id history for one environment', () => {
    driveWorktreeLifecycles(CYCLES)

    expect(
      sessionTabsRuntimeHistoryByEnvironment.get(ENV)?.retired.length ?? 0
    ).toBeLessThanOrEqual(8)
  })
})
