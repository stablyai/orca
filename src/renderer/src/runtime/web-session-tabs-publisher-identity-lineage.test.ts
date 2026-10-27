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

/** Treat headless-merge epochs as the same publisher everywhere: advance within a lineage without retiring the base, and inherit generation retirement. Exact-string fences let predecessors return; inconsistent lineage-aware fences let publishers retire themselves. */
const ENV = 'remote-runtime'
const WORKTREE = 'repo::/worktree'
const GEN_1 = 'renderer-generation-1'
const GEN_2 = 'renderer-generation-2'
const MERGED_GEN_1 = `${GEN_1}:headless-merge:abc`

function frame(publicationEpoch: string, snapshotVersion: number): RuntimeMobileSessionTabsResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal names every field this lineage suite reads; the cast only supplies the rest of the frame shape.
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

  // Merged epochs must inherit retirement; exact-string fencing let superseded publishers return.
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

  // Lineage-aware fencing alone makes base-to-merged publication retire itself; same-lineage updates must advance instead.
  it('admits a generation rebuilding under a merged epoch, and returning to a bare one', () => {
    expect(decideWebSessionTabsSnapshot(frame(GEN_1, 1), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame(MERGED_GEN_1, 2), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame(GEN_1, 3), ENV).apply).toBe(true)
  })

  // Only handover now retires publishers; verify lineage identity at recovery gate too.
  for (const [label, epoch] of [
    ['bare', GEN_1],
    ['headless-merge', MERGED_GEN_1]
  ] as const) {
    it(`fences a ${label} predecessor at the recovery gate as well`, () => {
      const firstReceived = recordReceivedWebSessionTabsSnapshot(ENV, frame(GEN_1, 5))
      expect(decideWebSessionTabsSnapshot(frame(GEN_1, 5), ENV).apply).toBe(true)

      const successorReceived = recordReceivedWebSessionTabsSnapshot(ENV, frame(GEN_2, 1))
      expect(successorReceived).toBeGreaterThan(firstReceived)
      expect(decideWebSessionTabsSnapshot(frame(GEN_2, 1), ENV).apply).toBe(true)

      // Late delivery cannot revive a retired lineage.
      const late = frame(epoch, 9)
      const lateReceived = recordReceivedWebSessionTabsSnapshot(ENV, late)
      expect(lateReceived).toBeGreaterThan(successorReceived)
      expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENV, late, lateReceived)).toBe(false)
    })
  }

  /** A retirement is per worktree: a sibling worktree's history must not fence this one. */
  it('keeps lineage retirement scoped to the worktree that retired it', () => {
    expect(decideWebSessionTabsSnapshot(frame(GEN_1, 5), ENV).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(frame(GEN_2, 1), ENV).apply).toBe(true)

    const sibling = { ...frame(MERGED_GEN_1, 1), worktree: 'repo::/other-worktree' }
    expect(decideWebSessionTabsSnapshot(sibling, ENV).apply).toBe(true)
  })
})
