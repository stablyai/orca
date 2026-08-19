import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordWebSessionFocusIntent } from './web-session-focus-intent'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab, TabGroupLayoutNode } from '../../../shared/tab-types'
import {
  moveWebSessionBrowserPlacement,
  recordWebSessionBrowserPlacement,
  takeWebSessionBrowserPlacementGroup
} from './web-session-browser-placement'
import {
  acceptReplayedWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  resolveHostSessionTabIdForWebSessionTab,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  layoutHasGroup,
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

  it('hydrates active host browser tabs with remote page handles', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: true,
            canGoForward: false,
            loadError: {
              code: -202,
              description: 'ERR_CERT_AUTHORITY_INVALID',
              validatedUrl: 'https://localhost:3443/'
            },
            certificateFailure: {
              challengeId: 'challenge-1',
              browserPageId: 'host-browser-page',
              errorCode: -202,
              error: 'ERR_CERT_AUTHORITY_INVALID',
              origin: 'https://localhost:3443',
              displayHost: 'localhost:3443',
              canProceed: true,
              observedAt: 123
            },
            color: '#3b82f6',
            isPinned: true,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const terminalId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.browserTabsByWorktree?.[WT]).toMatchObject([
      {
        id: 'host-browser-workspace',
        worktreeId: WT,
        activePageId: 'host-browser-page',
        pageIds: ['host-browser-page'],
        url: 'https://example.com/',
        title: 'Example Domain',
        canGoBack: true,
        canGoForward: false
      }
    ])
    expect(patch.browserPagesByWorkspace?.['host-browser-workspace']).toMatchObject([
      {
        id: 'host-browser-page',
        workspaceId: 'host-browser-workspace',
        worktreeId: WT,
        url: 'https://example.com/',
        title: 'Example Domain',
        loading: false,
        loadError: {
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/'
        }
      }
    ])
    expect(patch.remoteBrowserPageHandlesByPageId?.['host-browser-page']).toEqual({
      environmentId: ENV,
      remotePageId: 'host-browser-page'
    })
    expect(patch.browserCertificateFailuresByPageId?.['host-browser-page']).toEqual({
      challengeId: 'challenge-1',
      browserPageId: 'host-browser-page',
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      canProceed: true,
      observedAt: 123
    })
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminalId,
          entityId: terminalId,
          contentType: 'terminal'
        }),
        expect.objectContaining({
          id: 'host-browser-unified',
          entityId: 'host-browser-workspace',
          contentType: 'browser',
          label: 'Example Domain',
          color: '#3b82f6',
          isPinned: true
        })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      id: 'host-group-1',
      activeTabId: 'host-browser-unified',
      tabOrder: [terminalId, 'host-browser-unified']
    })
    expect(patch.activeBrowserTabId).toBe('host-browser-workspace')
    expect(patch.activeBrowserTabIdByWorktree?.[WT]).toBe('host-browser-workspace')
    expect(patch.activeTabId).toBe(terminalId)
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(terminalId)
    expect(patch.activeTabType).toBe('browser')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('browser')
  })

  it('keeps mirrored browser tabs in a rendered web layout group', () => {
    const visibleGroupId = 'visible-web-group'
    const hostOnlyGroupId = 'host-group-1'
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeGroupIdByWorktree: { [WT]: hostOnlyGroupId },
        groupsByWorktree: {
          [WT]: [
            {
              id: visibleGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            },
            {
              id: hostOnlyGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: visibleGroupId } }
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

    const browserUnifiedTab = patch.unifiedTabsByWorktree?.[WT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserUnifiedTab).toMatchObject({ groupId: visibleGroupId })
    expect(
      patch.groupsByWorktree?.[WT]?.find((group) => group.id === visibleGroupId)
    ).toMatchObject({
      activeTabId: 'host-browser-unified',
      tabOrder: ['host-browser-unified']
    })
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('keeps one remote browser in its client-owned side-preview group', () => {
    const editorGroupId = 'client-editor-group'
    const previewGroupId = 'client-preview-group'
    recordWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: 'host-browser-page',
      groupId: previewGroupId
    })

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        groupsByWorktree: {
          [WT]: [
            {
              id: editorGroupId,
              worktreeId: WT,
              activeTabId: 'local-editor',
              tabOrder: ['local-editor']
            },
            {
              id: previewGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: editorGroupId },
            second: { type: 'leaf', groupId: previewGroupId },
            ratio: 0.5
          }
        },
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'local-editor',
              worktreeId: WT,
              groupId: editorGroupId,
              contentType: 'editor',
              entityId: 'local-file',
              label: 'example.html',
              sortOrder: 0,
              createdAt: NOW,
              isPreview: false,
              isPinned: false,
              customLabel: null,
              color: null
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-tab',
            title: 'example.html',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'file:///srv/repo/example.html',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-tab', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const browserTab = patch.unifiedTabsByWorktree?.[WT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserTab).toMatchObject({ id: 'host-browser-tab', groupId: previewGroupId })
    expect(
      patch.groupsByWorktree?.[WT]?.find((group) => group.id === previewGroupId)
    ).toMatchObject({ activeTabId: 'host-browser-tab', tabOrder: ['host-browser-tab'] })
    expect(patch.groupsByWorktree?.[WT]?.find((group) => group.id === editorGroupId)).toMatchObject(
      { activeTabId: 'local-editor', tabOrder: ['local-editor'] }
    )
    expect(patch.browserTabsByWorktree?.[WT]).toHaveLength(1)
  })

  it('replays a pre-response browser snapshot after canonical placement and focus are known', () => {
    const editorGroupId = 'client-editor-group'
    const previewGroupId = 'client-preview-group'
    const editorFileId = '/srv/repo/example.html'
    const editorTab: Tab = {
      id: 'host-editor',
      worktreeId: WT,
      groupId: editorGroupId,
      contentType: 'editor',
      entityId: editorFileId,
      label: 'example.html',
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false,
      customLabel: null,
      color: null
    }
    const state = makeState({
      activeFileId: editorFileId,
      activeFileIdByWorktree: { [WT]: editorFileId },
      activeTabType: 'editor',
      activeTabTypeByWorktree: { [WT]: 'editor' },
      activeGroupIdByWorktree: { [WT]: editorGroupId },
      groupsByWorktree: {
        [WT]: [
          {
            id: editorGroupId,
            worktreeId: WT,
            activeTabId: editorTab.id,
            tabOrder: [editorTab.id]
          },
          {
            id: previewGroupId,
            worktreeId: WT,
            activeTabId: null,
            tabOrder: []
          }
        ]
      },
      layoutByWorktree: {
        [WT]: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: editorGroupId },
          second: { type: 'leaf', groupId: previewGroupId },
          ratio: 0.5
        }
      },
      unifiedTabsByWorktree: { [WT]: [editorTab] }
    })
    const snapshot = makeSnapshot(
      [
        {
          type: 'file',
          id: 'host-editor',
          title: 'example.html',
          filePath: editorFileId,
          relativePath: 'example.html',
          language: 'html',
          isDirty: false,
          isActive: false
        },
        {
          type: 'browser',
          id: 'host-browser-tab',
          title: 'example.html',
          browserWorkspaceId: 'host-browser-workspace',
          browserPageId: 'host-browser-page',
          url: 'file:///srv/repo/example.html',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          isActive: true
        }
      ],
      { activeTabId: 'host-browser-tab', activeTabType: 'browser' }
    )
    recordWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: 'provisional-browser-page',
      groupId: previewGroupId
    })

    const subscriptionPatch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
    const afterSubscription = {
      ...state,
      ...(subscriptionPatch as Partial<WebSessionTabsSyncState>)
    }
    expect(afterSubscription.activeTabType).toBe('editor')
    expect(
      afterSubscription.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'browser')
        ?.groupId
    ).not.toBe(previewGroupId)

    moveWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      fromRemotePageId: 'provisional-browser-page',
      toRemotePageId: 'host-browser-page'
    })
    recordWebSessionFocusIntent(
      { environmentId: ENV },
      WT,
      'host-browser-page',
      undefined,
      editorTab.id
    )
    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const replayPatch = applyFreshWebSessionTabsSnapshot(
      afterSubscription,
      snapshot,
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>
    const afterReplay = { ...afterSubscription, ...replayPatch }

    expect(
      afterReplay.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'browser')
    ).toMatchObject({ id: 'host-browser-tab', groupId: previewGroupId })
    expect(
      afterReplay.groupsByWorktree[WT]?.find((group) => group.id === previewGroupId)
    ).toMatchObject({ activeTabId: 'host-browser-tab', tabOrder: ['host-browser-tab'] })
    expect(afterReplay.activeBrowserTabIdByWorktree[WT]).toBe('host-browser-workspace')
    expect(afterReplay.activeTabTypeByWorktree[WT]).toBe('browser')
  })

  it('keeps a reserved side-preview split across a pre-publication snapshot', () => {
    const editorGroupId = 'client-editor-group'
    const previewGroupId = 'client-preview-group'
    const initialLayout: TabGroupLayoutNode = {
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: editorGroupId },
      second: { type: 'leaf', groupId: previewGroupId },
      ratio: 0.5
    }
    recordWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: 'pending-browser-page',
      groupId: previewGroupId
    })

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        groupsByWorktree: {
          [WT]: [
            {
              id: editorGroupId,
              worktreeId: WT,
              activeTabId: 'local-editor',
              tabOrder: ['local-editor']
            },
            {
              id: previewGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: { [WT]: initialLayout },
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'local-editor',
              worktreeId: WT,
              groupId: editorGroupId,
              contentType: 'editor',
              entityId: 'local-file',
              label: 'example.html',
              sortOrder: 0,
              createdAt: NOW,
              isPreview: false,
              isPinned: false,
              customLabel: null,
              color: null
            }
          ]
        }
      }),
      makeSnapshot([], {
        activeTabType: null,
        tabGroups: [{ id: editorGroupId, activeTabId: null, tabOrder: [], recentTabIds: [] }],
        tabGroupLayout: { type: 'leaf', groupId: editorGroupId }
      }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.groupsByWorktree?.[WT]?.map((group) => group.id)).toContain(previewGroupId)
    expect(layoutHasGroup(patch.layoutByWorktree?.[WT] ?? initialLayout, previewGroupId)).toBe(true)
  })

  it('forgets client browser placement after the host removes the page', () => {
    recordWebSessionBrowserPlacement({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: 'host-browser-page',
      groupId: 'client-preview-group'
    })
    takeWebSessionBrowserPlacementGroup({
      environmentId: ENV,
      worktreeId: WT,
      remotePageId: 'host-browser-page'
    })

    applyWebSessionTabsSnapshot(makeState(), makeSnapshot([]), ENV, NOW)

    expect(
      takeWebSessionBrowserPlacementGroup({
        environmentId: ENV,
        worktreeId: WT,
        remotePageId: 'host-browser-page'
      })
    ).toBeUndefined()
  })

  it('creates a rendered web layout group when stale group records do not include it', () => {
    const visibleGroupId = 'visible-web-group'
    const hostOnlyGroupId = 'host-group-1'
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeGroupIdByWorktree: { [WT]: hostOnlyGroupId },
        groupsByWorktree: {
          [WT]: [
            {
              id: hostOnlyGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: visibleGroupId } }
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

    const browserUnifiedTab = patch.unifiedTabsByWorktree?.[WT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserUnifiedTab).toMatchObject({ groupId: visibleGroupId })
    expect(patch.groupsByWorktree?.[WT]).toEqual([
      expect.objectContaining({
        id: visibleGroupId,
        activeTabId: 'host-browser-unified',
        tabOrder: ['host-browser-unified']
      })
    ])
    expect(patch.activeGroupIdByWorktree?.[WT]).toBe(visibleGroupId)
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('reuses a local browser workspace that already points at the host page', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'about:blank',
      title: 'New Tab',
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
      url: 'about:blank',
      title: 'New Tab',
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
      groupId: 'client-moved-group',
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

    const patch = applyWebSessionTabsSnapshot(
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
              id: 'client-moved-group',
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

    expect(patch.browserTabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.browserTabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: workspace.id,
      activePageId: page.id,
      url: 'https://example.com/',
      title: 'Example Domain'
    })
    expect(patch.browserPagesByWorkspace?.[workspace.id]).toMatchObject([
      {
        id: page.id,
        workspaceId: workspace.id,
        url: 'https://example.com/',
        title: 'Example Domain'
      }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]?.[0]?.groupId).toBe('client-moved-group')
    // Absent key, not a missing handle: the seeded { ENV, 'host-browser-page' } handle matched.
    expect(patch.remoteBrowserPageHandlesByPageId).toBeUndefined()
    expect(patch.unifiedTabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual([
      'local-browser-unified'
    ])
    expect(
      resolveHostSessionTabIdForWebSessionTab(makeState(), {
        environmentId: ENV,
        worktreeId: WT,
        tabId: 'local-browser-unified'
      })
    ).toBe('host-browser-unified')
  })

  it('removes mirrored browser tabs when the host closes the page', () => {
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
      url: workspace.url,
      title: workspace.title,
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: workspace.createdAt
    }
    const unifiedTab: Tab = {
      id: 'local-browser-unified',
      entityId: workspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: workspace.title,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: workspace.createdAt,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeBrowserTabId: workspace.id,
        activeBrowserTabIdByWorktree: { [WT]: workspace.id },
        activeTabType: 'browser',
        activeTabTypeByWorktree: { [WT]: 'browser' },
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
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.browserTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.browserPagesByWorkspace?.[workspace.id]).toBeUndefined()
    expect(patch.remoteBrowserPageHandlesByPageId?.[page.id]).toBeUndefined()
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeBrowserTabId).toBeNull()
    expect(patch.activeBrowserTabIdByWorktree?.[WT]).toBeNull()
    expect(patch.activeTabType).toBe('terminal')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })
})
