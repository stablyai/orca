import { beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
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
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot layout replay', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('mirrors two host terminals sharing a host group as one pane, never a split', () => {
    // Why: mirroring replays the host's own layout; it must not auto-split beside the first tab.
    const patch: Partial<WebSessionTabsSyncState> = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-2::${SECOND_LEAF_ID}`,
          title: 'second shell',
          parentTabId: 'host-tab-2',
          leafId: SECOND_LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ]),
      ENV,
      NOW
    )

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(2)
    expect(patch.groupsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.groupsByWorktree?.[WT]?.[0]?.tabOrder).toHaveLength(2)
    const layout = patch.layoutByWorktree?.[WT]
    expect(layout === undefined || layout.type === 'leaf').toBe(true)
  })
})
