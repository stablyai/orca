import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import {
  _getWebSessionTabsTrackingCountsForTest,
  applyFreshWebSessionTabsSnapshot,
  clearWebSessionTabsTrackingForEnvironment,
  resolveHostSessionTabIdForWebSessionTab,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
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

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('clears web session tracking maps when the host removes a worktree snapshot', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const unifiedTab: Tab = {
      id: 'local-browser-unified',
      entityId: workspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: 'New Tab',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }

    const patch = applyFreshWebSessionTabsSnapshot(
      makeState({
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const afterHostSnapshot = {
      ...makeState(),
      ...patch
    } as WebSessionTabsSyncState

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 1,
      hostMappings: 1,
      hostMappingWorktrees: 1
    })

    applyFreshWebSessionTabsSnapshot(
      afterHostSnapshot,
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
      freshness: 0,
      hostMappings: 0,
      hostMappingWorktrees: 0
    })
  })

  it('clears web session tracking maps for one runtime environment on teardown', () => {
    applyFreshWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    )
    applyFreshWebSessionTabsSnapshot(
      makeState({ activeWorktreeId: 'repo::/other-worktree' }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'other-host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'other-host-browser-workspace',
            browserPageId: 'other-host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        {
          worktree: 'repo::/other-worktree',
          activeTabId: 'other-host-browser-unified',
          activeTabType: 'browser'
        }
      ),
      'web-env-2',
      NOW
    )

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 2,
      hostMappings: 2,
      hostMappingWorktrees: 2
    })

    clearWebSessionTabsTrackingForEnvironment(ENV)

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 1,
      hostMappings: 1,
      hostMappingWorktrees: 1
    })
  })

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
