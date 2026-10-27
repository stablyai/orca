import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import {
  recordReceivedWebSessionTabsRemoval,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import {
  MAX_TRACKED_SESSION_TABS_RECEIPTS,
  nextReceivedSessionTabsFrame,
  VISIBILITY_INVENTORY_REMOVAL_EPOCH
} from './web-session-tabs-sync/state'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

// getState: snapshot receipt reads the held paired-tab closes; none here.
vi.mock('../store', () => ({ useAppStore: { setState: vi.fn(), getState: () => ({}) } }))
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

  // Stopping retirement is insufficient: reject same-epoch pre-close frames by delivery order even at higher versions.
  it('still fences a predecessor frame that was in flight when the removal landed', () => {
    recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(1))
    expect(decideWebSessionTabsSnapshot(liveFrame(1), ENVIRONMENT_ID).apply).toBe(true)

    // A list for this worktree reserves its frame while the worktree still exists.
    const delayedReceived = nextReceivedSessionTabsFrame()

    const removedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, removalFrame())
    expect(decideWebSessionTabsSnapshot(removalFrame(), ENVIRONMENT_ID).apply).toBe(true)
    expect(removedReceived).toBeGreaterThan(delayedReceived)

    const delayed = liveFrame(4)
    recordReceivedWebSessionTabsSnapshot(
      ENVIRONMENT_ID,
      delayed,
      delayedReceived,
      undefined,
      'bootstrap'
    )
    expect(admits(delayed, delayedReceived)).toBe(false)
  })

  // Bound receipt ledgers by frame, not entry count: one bootstrap inventory shares a frame across worktrees and must not evict its own evidence.
  it('keeps every receipt an inventory recorded under one frame, past the bound', () => {
    const requestReceivedFrame = nextReceivedSessionTabsFrame()
    const worktrees = Array.from(
      { length: MAX_TRACKED_SESSION_TABS_RECEIPTS + 64 },
      (_value, index) => `repo::/worktree-${index}`
    )
    for (const worktree of worktrees) {
      recordReceivedWebSessionTabsSnapshot(
        ENVIRONMENT_ID,
        { ...liveFrame(1), worktree },
        requestReceivedFrame,
        undefined,
        'bootstrap'
      )
    }

    for (const worktree of [worktrees[0]!, worktrees.at(-1)!]) {
      expect(
        shouldApplyRecoveredWebSessionTabsSnapshot(
          ENVIRONMENT_ID,
          { ...liveFrame(1), worktree },
          requestReceivedFrame
        )
      ).toBe(true)
    }
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

  // Synthesized none/v0 means unpublished, not a new publisher (host-session-snapshot-authority.ts); retiring the live process epoch here blocks future terminals.
  it('does not let an unpublished-worktree placeholder retire the live publisher', () => {
    const liveReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(1))
    expect(admits(liveFrame(1), liveReceived)).toBe(true)

    const removedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, removalFrame())
    expect(admits(removalFrame(), removedReceived)).toBe(true)

    const placeholder: RuntimeMobileSessionTabsResult = {
      ...liveFrame(1),
      publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
      snapshotVersion: 0,
      tabs: []
    }
    const placeholderReceived = recordReceivedWebSessionTabsSnapshot(
      ENVIRONMENT_ID,
      placeholder,
      undefined,
      undefined,
      'bootstrap'
    )
    admits(placeholder, placeholderReceived)

    // The user creates a terminal; the same live generation publishes its worktree again.
    const republished = liveFrame(2)
    const republishedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, republished)
    expect(admits(republished, republishedReceived)).toBe(true)
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

  // Exercise full recovery/receipt/decision path for bare and headless-merge epochs. Decision-only tests miss receipt retirement; exact-string differences must not make lockout timing-dependent.
  for (const [label, epoch] of [
    ['bare', LIVE_EPOCH],
    ['headless-merge', `${LIVE_EPOCH}:headless-merge:abc`]
  ] as const) {
    it(`readmits a ${label} republication after a removal, through the full path`, () => {
      const liveReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(1))
      expect(admits(liveFrame(1), liveReceived)).toBe(true)

      const removedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, removalFrame())
      expect(admits(removalFrame(), removedReceived)).toBe(true)

      const republished = { ...liveFrame(2), publicationEpoch: epoch }
      const republishedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, republished)
      expect(admits(republished, republishedReceived)).toBe(true)
    })
  }
})
