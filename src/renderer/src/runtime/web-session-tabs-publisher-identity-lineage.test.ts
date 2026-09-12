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
 * "Same publisher" had two answers that disagreed. `noteRetiredValue` treated a `:headless-merge:`
 * epoch as a successor of its base and retired the base when it became current, while
 * `sameSessionTabsPublicationLineage` treated the two as one publisher. The retired-value check
 * matched exactly, which is what kept those two from ever meeting: a suffixed frame was simply a
 * different string, so it never looked retired.
 *
 * The cost was that the same predecessor was accepted or rejected depending on which shape it
 * arrived in. These pin the single answer: a lineage sibling is the same publisher everywhere — it
 * advances the current epoch instead of superseding it, and it inherits its generation's
 * retirement instead of escaping it.
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
  } as RuntimeMobileSessionTabsResult
}

describe('a headless merge is the same publisher as its base epoch', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
  })

  /**
   * The fail-open half. A superseded generation used to walk straight back in by republishing
   * under a merged epoch, because the fence compared strings and the merged form was a different
   * string. The bare form of the identical frame was rejected.
   */
  for (const [label, epoch] of [
    ['bare', GEN_1],
    ['headless-merge', MERGED_GEN_1]
  ] as const) {
    it(`fences a ${label} frame from a generation a successor replaced`, () => {
      expect(decideWebSessionTabsSnapshot(frame(GEN_1, 5), ENV).apply).toBe(true)
      expect(decideWebSessionTabsSnapshot(frame(GEN_2, 1), ENV).apply).toBe(true)

      expect(decideWebSessionTabsSnapshot(frame(epoch, 9), ENV).apply).toBe(false)
    })
  }

  /**
   * The fail-closed half, and the reason this cannot be fixed in the fence alone. Making the fence
   * lineage-aware while the base epoch is still retired by its own merged form has the generation
   * retire itself: the rebuild arrives, retires `gen-1`, and is then rejected as a retired
   * generation. A publisher must be able to add runtime-owned surfaces without fencing itself out.
   */
  it('admits a generation rebuilding under a merged epoch, and returning to a bare one', () => {
    expect(decideWebSessionTabsSnapshot(frame(GEN_1, 1), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame(MERGED_GEN_1, 2), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame(GEN_1, 3), ENV).apply).toBe(true)
  })

  /** The same single answer has to hold at the recovery gate, which fences on identity too. */
  it('fences a merged predecessor at the recovery gate as well', () => {
    const firstReceived = recordReceivedWebSessionTabsSnapshot(ENV, frame(GEN_1, 5))
    expect(decideWebSessionTabsSnapshot(frame(GEN_1, 5), ENV).apply).toBe(true)

    const successorReceived = recordReceivedWebSessionTabsSnapshot(ENV, frame(GEN_2, 1))
    expect(successorReceived).toBeGreaterThan(firstReceived)
    expect(decideWebSessionTabsSnapshot(frame(GEN_2, 1), ENV).apply).toBe(true)

    // Late enough to win on delivery order; retired by lineage, so it must still lose.
    const merged = frame(MERGED_GEN_1, 9)
    const mergedReceived = recordReceivedWebSessionTabsSnapshot(ENV, merged)
    expect(mergedReceived).toBeGreaterThan(successorReceived)
    expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENV, merged, mergedReceived)).toBe(false)
  })

  /** A retirement is per worktree: a sibling worktree's history must not fence this one. */
  it('keeps lineage retirement scoped to the worktree that retired it', () => {
    expect(decideWebSessionTabsSnapshot(frame(GEN_1, 5), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame(GEN_2, 1), ENV).apply).toBe(true)

    const sibling = { ...frame(MERGED_GEN_1, 1), worktree: 'repo::/other-worktree' }
    expect(decideWebSessionTabsSnapshot(sibling, ENV).apply).toBe(true)
  })
})
