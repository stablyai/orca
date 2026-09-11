import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync'
import { clearWebSessionTabsTrackingForWorktree } from './web-session-tabs-sync/tracking-lifecycle'
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import {
  MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY,
  SESSION_TABS_PUBLICATION_FENCE_RETENTION_MS,
  sessionTabsPublicationEpochHistoryByWorktree
} from './web-session-tabs-sync/state'

vi.mock('../store', () => ({
  useAppStore: { setState: vi.fn(), getState: vi.fn(() => ({})) }
}))
vi.mock('./web-session-terminal-handle-events', () => ({
  queueAcceptedWebSessionTerminalSnapshot: vi.fn()
}))

// What the cap costs, and why the bound has to be fail-CLOSED.
//
// The epoch history is deliberately retained after a worktree's live record is dropped: it is the
// tombstone fence that stops a sibling stream's late frame from a retired publisher being applied
// to a workspace that has moved on. Bounding the map by LRU evicts exactly those tombstones —
// a still-publishing worktree renotes its epoch on every accepted frame, so the eviction victim is
// always a fence.
//
// Absence is fail-open on both read paths: `hasRetiredValue` answers `false` for a missing entry,
// so `isRetiredSessionTabsPublicationEpoch` cannot tell "never seen" from "fenced and forgotten".
// Worse, `recordReceivedWebSessionTabsSnapshot` then RE-NOTES the evicted epoch as current,
// resurrecting the publisher the fence retired.

const ENV = 'env-evicted-fence'
const FENCED_WORKTREE = 'repo::/w/fenced'
const FENCED_EPOCH = 'epoch-fenced-publisher'
const RUNTIME_ID = 'runtime-shared'

let nextFrame = 1

function snapshotFor(worktree: string, publicationEpoch: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch,
    snapshotVersion: 1,
    tabs: [],
    groups: [],
    tabBarOrder: [],
    activeTabId: null
  } as unknown as RuntimeMobileSessionTabsResult
}

/** Observe a worktree on a publisher, then let the host retract it: epoch retired, tombstone kept. */
function fenceWorktree(): void {
  recordReceivedWebSessionTabsSnapshot(
    ENV,
    snapshotFor(FENCED_WORKTREE, FENCED_EPOCH),
    undefined,
    RUNTIME_ID
  )
  recordReceivedWebSessionTabsSnapshot(
    ENV,
    snapshotFor(FENCED_WORKTREE, 'epoch-successor'),
    undefined,
    RUNTIME_ID
  )
  clearWebSessionTabsTrackingForWorktree(ENV, FENCED_WORKTREE)
}

/** Ordinary long-session traffic: other worktrees, each noting its own epoch. */
function noteOtherWorktrees(count: number): void {
  for (let i = 0; i < count; i += 1) {
    const worktree = `repo::/w/other-${i}`
    recordReceivedWebSessionTabsSnapshot(
      ENV,
      snapshotFor(worktree, `epoch-other-${i}`),
      undefined,
      RUNTIME_ID
    )
  }
}

/** The retired publisher's late frame, arriving on a sibling stream after the retraction. */
function deliverLateFrameFromRetiredPublisher(): boolean {
  const snapshot = snapshotFor(FENCED_WORKTREE, FENCED_EPOCH)
  const frame = (nextFrame += 1)
  recordReceivedWebSessionTabsSnapshot(ENV, snapshot, frame, RUNTIME_ID)
  return shouldApplyRecoveredWebSessionTabsSnapshot(ENV, snapshot, frame, RUNTIME_ID)
}

const FENCED_KEY = `${ENV}:${FENCED_WORKTREE}`

describe('publication-epoch fence against its own size cap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetWebSessionTabsSnapshotFreshnessForTests()
    nextFrame = 1
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The control: with the tombstone present, the fence does its job.
  it('rejects the retired publisher’s late frame while the tombstone is retained', () => {
    fenceWorktree()
    expect(sessionTabsPublicationEpochHistoryByWorktree.size).toBe(1)

    expect(deliverLateFrameFromRetiredPublisher()).toBe(false)
  })

  // The regression a pure count cap introduced: enough ordinary traffic to push the tombstone out
  // of the window evicted the fence, and the late frame was then ACCEPTED and re-noted as current.
  // The cap has to yield to a fence that can still be beaten by a frame in flight.
  it('keeps a young fence past the cap, and still rejects the late frame', () => {
    fenceWorktree()
    noteOtherWorktrees(MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY + 8)

    expect(sessionTabsPublicationEpochHistoryByWorktree.has(FENCED_KEY)).toBe(true)
    expect(sessionTabsPublicationEpochHistoryByWorktree.size).toBeGreaterThan(
      MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY
    )
    expect(deliverLateFrameFromRetiredPublisher()).toBe(false)
  })

  // The other half: the cap is not abandoned, only deferred. Once a fence has outlived the delivery
  // window it cannot be beaten by anything still in flight, so it drains and the bound holds.
  it('drains to the cap once the fences have outlived the delivery window', () => {
    fenceWorktree()
    noteOtherWorktrees(MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY + 8)
    vi.advanceTimersByTime(SESSION_TABS_PUBLICATION_FENCE_RETENTION_MS + 1)

    // A note for a NEW key: re-noting an existing key at an unchanged epoch is skipped by the
    // receive path, so it would never reach the eviction pass.
    recordReceivedWebSessionTabsSnapshot(
      ENV,
      snapshotFor('repo::/w/drain-trigger', 'epoch-drain-trigger'),
      undefined,
      RUNTIME_ID
    )

    expect(sessionTabsPublicationEpochHistoryByWorktree.has(FENCED_KEY)).toBe(false)
    expect(sessionTabsPublicationEpochHistoryByWorktree.size).toBeLessThanOrEqual(
      MAX_SESSION_TABS_PUBLICATION_EPOCH_HISTORY
    )
  })
})
