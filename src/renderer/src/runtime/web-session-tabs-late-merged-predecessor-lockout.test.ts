import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

/**
 * "Is this epoch retired" had two answers one file apart. The recovery gate
 * (`isRetiredSessionTabsPublicationEpoch`) answers by lineage; the receipt ledger
 * (`recordReceivedWebSessionTabsSnapshot`) still matched the string exactly. A late
 * `:headless-merge:` frame from a superseded generation was therefore rejected at the gate but
 * had already passed the ledger's check, noted itself current, and pushed the live successor onto
 * `retired`. The successor's next frame was then rejected: a publisher that never stopped running
 * was locked out of its worktree.
 *
 * `fences a merged predecessor at the recovery gate as well` stops one frame early — it asserts
 * the merged frame is rejected and never asks whether the successor still gets in afterwards.
 */
const ENV = 'remote-runtime'
const WORKTREE = 'repo::/worktree'
const GEN_1 = 'renderer-generation-1'
const GEN_2 = 'renderer-generation-2'
const MERGED_GEN_1 = `${GEN_1}:headless-merge:abc`

function frame(publicationEpoch: string, snapshotVersion: number): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

/** The composed gate every production apply path runs. */
function admits(snapshot: RuntimeMobileSessionTabsResult, receivedFrame: number): boolean {
  return (
    shouldApplyRecoveredWebSessionTabsSnapshot(ENV, snapshot, receivedFrame) &&
    decideWebSessionTabsSnapshot(snapshot, ENV).apply
  )
}

describe('a late frame from a retired generation must not retire the live successor', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
  })

  for (const [label, epoch] of [
    ['bare', GEN_1],
    ['headless-merge', MERGED_GEN_1]
  ] as const) {
    it(`keeps admitting the successor after a ${label} predecessor frame is rejected`, () => {
      const firstReceived = recordReceivedWebSessionTabsSnapshot(ENV, frame(GEN_1, 5))
      expect(admits(frame(GEN_1, 5), firstReceived)).toBe(true)

      const successorReceived = recordReceivedWebSessionTabsSnapshot(ENV, frame(GEN_2, 1))
      expect(admits(frame(GEN_2, 1), successorReceived)).toBe(true)

      // Late enough to win on delivery order; retired by lineage, so it must lose...
      const late = frame(epoch, 9)
      const lateReceived = recordReceivedWebSessionTabsSnapshot(ENV, late)
      expect(admits(late, lateReceived)).toBe(false)

      // ...and losing must cost it nothing more than that frame. The successor is still publishing.
      const next = frame(GEN_2, 2)
      const nextReceived = recordReceivedWebSessionTabsSnapshot(ENV, next)
      expect(admits(next, nextReceived)).toBe(true)
    })
  }
})
