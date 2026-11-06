import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

// getState: snapshot receipt reads the held paired-tab closes; none here.
vi.mock('../store', () => ({ useAppStore: { setState: vi.fn(), getState: () => ({}) } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

/** Fence retired publisher lineages in both recovery and receipt ledger. A late headless-merge predecessor must neither enter nor retire its live successor; testing rejection alone misses successor lockout. */
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
