import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'

import { _getWebSessionTabsTrackingCountsForTest } from './web-session-tabs-sync/tracking-lifecycle'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'

import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('clears one worktree mapping without dropping a sibling in the same environment', () => {
    // Why: POSIX paths may contain ':', so this sibling's worktree id is prefixed by WT's — the case a prefix scan wiped.
    const secondWorktree = `${WT}:2`
    const terminalSnapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'host shell',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1'
      }
    ])
    const secondSnapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-2::${SECOND_LEAF_ID}`,
          title: 'second shell',
          parentTabId: 'host-tab-2',
          leafId: SECOND_LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ],
      { worktree: secondWorktree }
    )
    applyFreshWebSessionTabsSnapshot(makeState(), terminalSnapshot, ENV, NOW)
    applyFreshWebSessionTabsSnapshot(makeState(), secondSnapshot, ENV, NOW)

    applyFreshWebSessionTabsSnapshot(
      makeState(),
      {
        ...makeSnapshot([], {
          publicationEpoch: 'removed-epoch',
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null
        }),
        removed: true
      } as RuntimeMobileSessionTabsResult,
      ENV,
      NOW + 1
    )

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 1,
      hostMappings: 1,
      hostMappingWorktrees: 1
    })
    expect(
      resolveHostSessionTabIdForWebSessionTab(makeState(), {
        environmentId: ENV,
        worktreeId: WT,
        tabId: toWebTerminalSurfaceTabId('host-tab-1')
      })
    ).toBeNull()
    expect(
      resolveHostSessionTabIdForWebSessionTab(makeState(), {
        environmentId: ENV,
        worktreeId: secondWorktree,
        tabId: toWebTerminalSurfaceTabId('host-tab-2')
      })
    ).toBe('host-tab-2')
  })
})
