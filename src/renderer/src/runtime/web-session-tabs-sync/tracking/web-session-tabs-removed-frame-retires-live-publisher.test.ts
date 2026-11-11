import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { decideWebSessionTabsSnapshot } from '../tracking-decisions'
import {
  recordReceivedWebSessionTabsRemoval,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from '../tracking'
import {
  MAX_TRACKED_SESSION_TABS_RECEIPTS,
  nextReceivedSessionTabsFrame,
  VISIBILITY_INVENTORY_REMOVAL_EPOCH
} from '../state'
import '../../../../../shared/runtime-types'
import { resetWebSessionTabsSyncTestState } from '../testing/web-session-tabs-sync.test-fixture'

// getState: snapshot receipt reads the held paired-tab closes; none here.
vi.mock('../../../store/index', () => ({
  useAppStore: { setState: vi.fn(), getState: () => ({}) }
}))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

/** removed:<t> retracts a worktree, not its still-live publisher. Pre-close in-flight lists and post-close republication share an epoch, so fence by receipt order through the full recovery/decision path, never by retiring that generation. */
const ENVIRONMENT_ID = 'remote-runtime'
const WORKTREE = 'repo::/worktree'
const LIVE_EPOCH = 'renderer-generation-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function liveFrame(snapshotVersion: number): RuntimeMobileSessionTabsResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the live frame names every field this suite reads; the cast only supplies the rest of the frame shape.
  return {
    worktree: WORKTREE,
    publicationEpoch: LIVE_EPOCH,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: `host-tab::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `host-tab::${LEAF_ID}`,
        parentTabId: 'host-tab',
        leafId: LEAF_ID,
        title: 'Terminal',
        isActive: true,
        status: 'ready',
        terminal: 'term_live'
      }
    ]
  } as RuntimeMobileSessionTabsResult
}

function removalFrame(): RuntimeMobileSessionTabsResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the removal frame carries `removed: true`, which the published frame type does not declare.
  return {
    worktree: WORKTREE,
    publicationEpoch: `removed:${(1_700_000_000_000).toString(36)}`,
    snapshotVersion: 0,
    removed: true,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  } as RuntimeMobileSessionTabsResult
}

/** The composed gate every production apply path runs: recovery ordering AND the frame decision. */
function admits(snapshot: RuntimeMobileSessionTabsResult, receivedFrame: number): boolean {
  return (
    shouldApplyRecoveredWebSessionTabsSnapshot(ENVIRONMENT_ID, snapshot, receivedFrame) &&
    decideWebSessionTabsSnapshot(snapshot, ENVIRONMENT_ID).apply
  )
}

describe('a removal frame must not retire the publisher that is still live', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
  })

  // Retraction boundaries must survive ledger bounds or delayed pre-close frames resurrect tabs.
  it('keeps a worktree fence after enough other worktrees to evict its receipt', () => {
    const liveReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(1))
    expect(admits(liveFrame(1), liveReceived)).toBe(true)

    const delayedReceived = nextReceivedSessionTabsFrame()
    const removedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, removalFrame())
    expect(admits(removalFrame(), removedReceived)).toBe(true)

    // Churn past both capacity and frame-age bounds before the delayed list arrives.
    for (let index = 0; index < MAX_TRACKED_SESSION_TABS_RECEIPTS + 16; index += 1) {
      const worktree = `repo::/churn-${index}`
      recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, { ...liveFrame(1), worktree })
      recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, { ...removalFrame(), worktree })
    }

    const delayed = liveFrame(9)
    recordReceivedWebSessionTabsSnapshot(
      ENVIRONMENT_ID,
      delayed,
      delayedReceived,
      undefined,
      'bootstrap'
    )
    expect(admits(delayed, delayedReceived)).toBe(false)
  })

  // Live republication overwrites the receipt slot; only the retraction boundary rejects pre-close lists with versions higher than the restarted counter.
  it('fences a pre-close list that lands after the live publisher already republished', () => {
    const liveReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(1))
    expect(admits(liveFrame(1), liveReceived)).toBe(true)

    // The list reserves its place while the terminal is still open.
    const delayedReceived = nextReceivedSessionTabsFrame()

    const removedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, removalFrame())
    expect(admits(removalFrame(), removedReceived)).toBe(true)

    // A client recreates a terminal; the live publisher speaks again and overwrites the slot.
    const republished = liveFrame(2)
    const republishedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, republished)
    expect(admits(republished, republishedReceived)).toBe(true)

    const delayed = liveFrame(9)
    recordReceivedWebSessionTabsSnapshot(
      ENVIRONMENT_ID,
      delayed,
      delayedReceived,
      undefined,
      'bootstrap'
    )
    expect(admits(delayed, delayedReceived)).toBe(false)
  })

  // Retraction boundaries only advance. Older inventory omissions must not rewind evidence from newer stream frames and readmit delayed lists.
  it('does not let an inventory omission older than the last stream frame rewind the boundary', () => {
    const inventoryReceived = nextReceivedSessionTabsFrame()
    const delayedReceived = nextReceivedSessionTabsFrame()
    const streamReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(3))
    expect(delayedReceived).toBeGreaterThan(inventoryReceived)
    expect(streamReceived).toBeGreaterThan(delayedReceived)

    // The inventory sweep finally reports this worktree missing, on its older frame.
    recordReceivedWebSessionTabsRemoval(
      ENVIRONMENT_ID,
      WORKTREE,
      inventoryReceived,
      VISIBILITY_INVENTORY_REMOVAL_EPOCH
    )

    // A list reserved before the stream frame lands last, carrying a genuinely stale version.
    const delayed = liveFrame(1)
    recordReceivedWebSessionTabsSnapshot(
      ENVIRONMENT_ID,
      delayed,
      delayedReceived,
      undefined,
      'bootstrap'
    )
    expect(
      shouldApplyRecoveredWebSessionTabsSnapshot(ENVIRONMENT_ID, delayed, delayedReceived)
    ).toBe(false)
  })
})
