import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync'
import { resetWebSessionTabsSyncTestState } from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

/**
 * A host drops a worktree's entry when its last tab closes and announces that with a synthetic
 * `removed:<t>` epoch. That announcement is a retraction by a transient publisher, not a handover:
 * the renderer generation that published the worktree is still the live one and will publish the
 * worktree again the moment a client recreates a terminal in it.
 */
/**
 * KNOWN RED, and the collision is the finding. Removing the retirement makes this pass but breaks
 * `web-session-tabs-sync.test.ts > keeps a removed worktree fenced against delayed predecessor
 * epochs`, which asserts that a same-epoch frame at a HIGHER version after a removal must be
 * rejected. At this layer the two are the same frame: `decideWebSessionTabsSnapshot` has no
 * received-frame information, so it cannot tell a delayed predecessor from the live publisher
 * speaking again. Only the caller (`shouldApplyRecoveredWebSessionTabsSnapshot`, which does hold
 * `receivedFrame`) can separate them — and it currently defers to the same epoch fence.
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

describe('a removal frame must not retire the publisher that is still live', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
  })

  // KNOWN RED. The fix is not a one-liner: see the collision noted below.
  it.fails('readmits the live publisher after its worktree was emptied and removed', () => {
    expect(decideWebSessionTabsSnapshot(liveFrame(1), ENVIRONMENT_ID).apply).toBe(true)
    expect(decideWebSessionTabsSnapshot(removalFrame(), ENVIRONMENT_ID).apply).toBe(true)

    // The user recreates a terminal. The same renderer generation publishes the worktree again.
    expect(decideWebSessionTabsSnapshot(liveFrame(2), ENVIRONMENT_ID).apply).toBe(true)
  })

  // Why the e2e only catches this sometimes: the host's rebuild often republishes under a merged
  // epoch, and the retired-value check is an exact string match, so the suffix walks straight past
  // the fence. A bare same-epoch republication is the one that gets locked out.
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
})
