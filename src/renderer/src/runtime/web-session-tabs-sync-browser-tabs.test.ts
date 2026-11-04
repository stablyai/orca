import { beforeEach, describe, expect, it, vi } from 'vitest'
import { recordWebSessionFocusIntent } from './web-session-focus-intent'
import { buildOwnedEditorFileId } from '../store/slices/editor/file-ids/editor-file-ids'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import {
  moveWebSessionBrowserPlacement,
  recordWebSessionBrowserPlacement
} from './web-session-browser-placement'
import { acceptReplayedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-lifecycle'
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot
} from './web-session-tabs-sync/snapshot-api'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import {
  ENV,
  NOW,
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

  it('replays a pre-response browser snapshot after canonical placement and focus are known', () => {
    const editorGroupId = 'client-editor-group'
    const previewGroupId = 'client-preview-group'
    const editorFilePath = '/srv/repo/example.html'
    // A server's file is named by its owned id from the first open.
    const editorFileId = buildOwnedEditorFileId(editorFilePath, WT, ENV)
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
          filePath: editorFilePath,
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
})
