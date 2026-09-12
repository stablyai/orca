import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  recordReceivedWebSessionTabsRemoval,
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import {
  nextReceivedSessionTabsFrame,
  VISIBILITY_INVENTORY_REMOVAL_EPOCH
} from './web-session-tabs-sync/state'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

/**
 * A host drops a worktree's entry when its last tab closes and announces that with a synthetic
 * `removed:<t>` epoch. That announcement is a retraction by a transient publisher, not a handover:
 * the renderer generation that published the worktree is still the live one and will publish the
 * worktree again the moment a client recreates a terminal in it. Recording the retraction as a
 * publication retired that live generation and locked it out of its own worktree.
 *
 * A retraction and the live publisher's next frame are the same epoch at a higher version, so epoch
 * identity cannot separate them and never could. Delivery order can: a frame that reserved its
 * received frame before the retraction was already in flight, and one that arrives after it is the
 * live publisher speaking again. `shouldApplyRecoveredWebSessionTabsSnapshot` holds that order and
 * is the gate every production apply path passes through before `decideWebSessionTabsSnapshot`.
 */
const ENVIRONMENT_ID = 'remote-runtime'
const WORKTREE = 'repo::/worktree'
const LIVE_EPOCH = 'renderer-generation-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function liveFrame(snapshotVersion: number): RuntimeMobileSessionTabsResult {
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

  it('readmits the live publisher after its worktree was emptied and removed', () => {
    expect(decideWebSessionTabsSnapshot(liveFrame(1), ENVIRONMENT_ID).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(removalFrame(), ENVIRONMENT_ID).apply).toBe(true)

    // The user recreates a terminal. The same renderer generation publishes the worktree again.
    expect(decideWebSessionTabsSnapshot(liveFrame(2), ENVIRONMENT_ID).apply).toBe(true)
  })

  /**
   * The case above is not sufficient on its own: it never records a received frame, and the receipt
   * ledger retires epochs too. Dropping only the retirement inside `decideWebSessionTabsSnapshot`
   * turns it green while the publisher stays locked out on every real path.
   */
  it('readmits the live publisher through the full receive-and-apply path', () => {
    const liveReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(1))
    expect(admits(liveFrame(1), liveReceived)).toBe(true)

    const removedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, removalFrame())
    expect(admits(removalFrame(), removedReceived)).toBe(true)

    const republished = liveFrame(2)
    const republishedReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, republished)
    expect(republishedReceived).toBeGreaterThan(removedReceived)
    expect(admits(republished, republishedReceived)).toBe(true)
  })

  /**
   * The other side of the same contract, and the reason the fix is not simply "stop retiring": a
   * frame that was already in flight when the retraction landed carries the same epoch at a higher
   * version, and must still lose. Only its place in the delivery order says so.
   */
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

  /**
   * The boundary is evidence, so a retraction may only ever advance it. A visibility-resume
   * inventory reserves its received frame before it lists, so an omission it reports can be older
   * than a stream frame that landed meanwhile. Letting that stale omission rewind the ledger would
   * forget the stream frame's version and readmit a delayed frame the ledger had already outranked.
   */
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

  /**
   * The recovery gate's epoch fence is the only thing between a superseded generation and the
   * mirror when a sibling stream delivers its frame late enough to outrank the successor on
   * delivery order. Retractions no longer retire anything, so a genuine handover is now the only
   * thing that exercises this fence — it is narrower than it was, not unreachable.
   */
  it('fences a superseded generation whose late frame outranks the successor on delivery order', () => {
    const firstReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, liveFrame(1))
    expect(admits(liveFrame(1), firstReceived)).toBe(true)

    const successor = { ...liveFrame(1), publicationEpoch: 'renderer-generation-2' }
    const successorReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, successor)
    expect(admits(successor, successorReceived)).toBe(true)

    // A sibling stream delivers the predecessor's frame after the handover, so delivery order alone
    // would admit it. Its generation is retired, and that is what has to reject it.
    const late = liveFrame(9)
    const lateReceived = recordReceivedWebSessionTabsSnapshot(ENVIRONMENT_ID, late)
    expect(lateReceived).toBeGreaterThan(successorReceived)
    expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENVIRONMENT_ID, late, lateReceived)).toBe(
      false
    )
  })

  /**
   * Rate-independence, which is the point of fixing this at the root. The defect surfaced only 1
   * run in 6 because the retired-value check is an exact string match while the lineage check
   * treats `:headless-merge:` as the same publisher, so a merged republication walked past a fence
   * a bare one hit. The removal path must no longer care which shape arrives; if it did, the defect
   * would not be fixed, only re-rated.
   */
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

  // Why this stays fenced: a genuinely superseded generation is retired by a *successor's*
  // publication, which is a handover. Only the removal path must stop retiring.
  it('still fences a predecessor generation that a successor replaced', () => {
    expect(decideWebSessionTabsSnapshot(liveFrame(1), ENVIRONMENT_ID).apply).toBe(true)
    expect(
      decideWebSessionTabsSnapshot(
        { ...liveFrame(1), publicationEpoch: 'renderer-generation-2' },
        ENVIRONMENT_ID
      ).apply
    ).toBe(true)

    expect(decideWebSessionTabsSnapshot(liveFrame(2), ENVIRONMENT_ID).apply).toBe(false)
  })

  /**
   * The suffix case, kept because it is why the e2e journey only failed 1 run in 6: the host's
   * rebuild often republishes under a merged epoch, and the retired-value check is an exact string
   * match, so the suffix walked straight past the fence. A bare same-epoch republication was the
   * one that got locked out. This must keep passing for the same reason as the bare case now does,
   * not because the string differs.
   */
  it('readmits the same generation when its republication carries a headless-merge suffix', () => {
    expect(decideWebSessionTabsSnapshot(liveFrame(1), ENVIRONMENT_ID).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(removalFrame(), ENVIRONMENT_ID).apply).toBe(true)

    expect(
      decideWebSessionTabsSnapshot(
        { ...liveFrame(2), publicationEpoch: `${LIVE_EPOCH}:headless-merge:abc` },
        ENVIRONMENT_ID
      ).apply
    ).toBe(true)
  })
})
