import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { recordWebSessionFocusIntent } from './web-session-focus-intent'

import { acceptReplayedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-lifecycle'
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot
} from './web-session-tabs-sync/snapshot-api'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  ENV,
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

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('replays a snapshot that beat the RPC response and focuses the exact adopted leaf', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const root = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, leafId: LEAF_ID },
      second: { type: 'leaf' as const, leafId: SECOND_LEAF_ID }
    }
    const currentLayout = {
      root,
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1',
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-2'
      }
    }
    const state = makeState({
      activeTabId: mirroredTabId,
      activeTabIdByWorktree: { [WT]: mirroredTabId },
      tabsByWorktree: {
        [WT]: [
          {
            id: mirroredTabId,
            ptyId: 'remote:web-env-1@@terminal-2',
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      },
      terminalLayoutsByTabId: { [mirroredTabId]: currentLayout }
    })
    const snapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: currentLayout,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'shell',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          parentLayout: currentLayout,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ],
      {
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: 'host-tab-1',
            tabOrder: ['host-tab-1']
          }
        ]
      }
    )

    const subscriptionPatch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
    const afterSubscription = {
      ...state,
      ...(subscriptionPatch as Partial<WebSessionTabsSyncState>)
    }
    expect(afterSubscription.terminalLayoutsByTabId[mirroredTabId]?.activeLeafId).toBe(
      SECOND_LEAF_ID
    )

    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-1', LEAF_ID)
    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const replayPatch = applyFreshWebSessionTabsSnapshot(
      afterSubscription,
      snapshot,
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(replayPatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe('remote:web-env-1@@terminal-1')
    expect(replayPatch.terminalLayoutsByTabId?.[mirroredTabId]).toMatchObject({
      activeLeafId: LEAF_ID,
      expandedLeafId: LEAF_ID
    })
  })

  it('retains exact-leaf focus intent when a split sibling publishes first', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const siblingPtyId = 'remote:web-env-1@@terminal-2'
    const state = makeState({
      activeTabId: mirroredTabId,
      activeTabIdByWorktree: { [WT]: mirroredTabId },
      tabsByWorktree: {
        [WT]: [
          {
            id: mirroredTabId,
            ptyId: siblingPtyId,
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      }
    })
    const sibling = {
      type: 'terminal' as const,
      id: `host-tab-1::${SECOND_LEAF_ID}`,
      title: 'shell',
      parentTabId: 'host-tab-1',
      leafId: SECOND_LEAF_ID,
      isActive: true,
      status: 'ready' as const,
      terminal: 'terminal-2'
    }
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-1', LEAF_ID)

    const partialPatch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([sibling]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    expect(partialPatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe(siblingPtyId)

    const afterPartial = { ...state, ...partialPatch }
    const completePatch = applyWebSessionTabsSnapshot(
      afterPartial,
      makeSnapshot([
        sibling,
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(completePatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe('remote:web-env-1@@terminal-1')
    expect(completePatch.terminalLayoutsByTabId?.[mirroredTabId]?.activeLeafId).toBe(LEAF_ID)
  })
})
