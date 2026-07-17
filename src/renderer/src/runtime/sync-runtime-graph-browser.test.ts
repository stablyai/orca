import { describe, expect, it } from 'vitest'
import {
  buildMobileSessionTabSnapshots,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from './sync-runtime-graph'
import type { AppState } from '../store/types'
import { getWebAiAccountWorkspaceId, WEB_AI_BROWSER_WORKSPACE_ID } from '../../../shared/constants'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    browserCertificateFailuresByPageId: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

function makeBrowserWorkspace(
  title = 'Example'
): NonNullable<AppState['browserTabsByWorktree'][string]>[number] {
  return {
    id: 'browser-1',
    worktreeId: 'wt-1',
    activePageId: 'page-1',
    pageIds: ['page-1'],
    url: 'https://example.com',
    title,
    loading: false,
    faviconUrl: null,
    canGoBack: true,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

describe('browser mobile session sync', () => {
  it('changes when browser tab page state changes', () => {
    const base = makeState({
      browserTabsByWorktree: {
        'wt-1': [makeBrowserWorkspace()]
      }
    })
    const changed = getRuntimeMobileSessionSyncKey(
      makeState({
        ...base,
        browserTabsByWorktree: {
          'wt-1': [makeBrowserWorkspace('Changed')]
        }
      })
    )

    expect(runtimeMobileSessionSyncKeysEqual(getRuntimeMobileSessionSyncKey(base), changed)).toBe(
      false
    )
  })

  it('publishes browser tabs with active page metadata', () => {
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          { id: 'group-1', activeTabId: 'unified-browser-1', tabOrder: ['unified-browser-1'] }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-browser-1',
            groupId: 'group-1',
            contentType: 'browser',
            entityId: 'browser-1',
            title: 'Browser'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      browserTabsByWorktree: { 'wt-1': [makeBrowserWorkspace()] },
      browserPagesByWorkspace: {
        'browser-1': [
          {
            id: 'page-1',
            workspaceId: 'browser-1',
            worktreeId: 'wt-1',
            url: 'https://example.com/path',
            title: 'Example Page',
            loading: false,
            faviconUrl: null,
            canGoBack: true,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as unknown as AppState['browserPagesByWorkspace'],
      browserCertificateFailuresByPageId: {
        'page-1': {
          challengeId: 'challenge-1',
          browserPageId: 'page-1',
          errorCode: -202,
          error: 'ERR_CERT_AUTHORITY_INVALID',
          origin: 'https://localhost:3443',
          displayHost: 'localhost:3443',
          canProceed: true,
          observedAt: 123
        }
      }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'browser',
        id: 'unified-browser-1',
        browserWorkspaceId: 'browser-1',
        browserPageId: 'page-1',
        title: 'Example Page',
        url: 'https://example.com/path',
        canGoBack: true,
        certificateFailure: {
          challengeId: 'challenge-1',
          browserPageId: 'page-1'
        },
        isActive: true
      }
    ])
  })

  it('does not resurrect a stale workspace failure after the active page clears it', () => {
    const staleError = {
      code: -202,
      description: 'ERR_CERT_AUTHORITY_INVALID',
      validatedUrl: 'https://localhost:3443/'
    }
    const workspace = { ...makeBrowserWorkspace(), loadError: staleError }
    const activePage = {
      ...workspace,
      id: 'page-1',
      workspaceId: workspace.id,
      loadError: null
    }
    const state = makeState({
      activeBrowserTabIdByWorktree: { 'wt-1': workspace.id },
      browserTabsByWorktree: { 'wt-1': [workspace] },
      browserPagesByWorkspace: { [workspace.id]: [activePage] }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs[0]).toMatchObject({
      type: 'browser',
      loadError: null
    })
  })

  it('publishes fallback browser tabs by workspace id when no unified tab exists', () => {
    const state = makeState({
      activeBrowserTabIdByWorktree: { 'wt-1': 'browser-1' },
      browserTabsByWorktree: { 'wt-1': [makeBrowserWorkspace()] }
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'browser',
        id: 'browser-1',
        browserWorkspaceId: 'browser-1',
        title: 'Example',
        isActive: true
      }
    ])
  })

  it.each([getWebAiAccountWorkspaceId('private-account'), WEB_AI_BROWSER_WORKSPACE_ID])(
    'excludes Electron-local Web AI workspace %s while preserving ordinary browser publication',
    (webAiWorkspaceId) => {
      const ordinaryWorkspace = makeBrowserWorkspace('Ordinary Browser')
      const webAiWorkspace = {
        ...makeBrowserWorkspace('Private Chat'),
        id: 'web-ai-browser',
        worktreeId: webAiWorkspaceId,
        activePageId: 'web-ai-page',
        pageIds: ['web-ai-page'],
        url: 'https://chatgpt.com/c/private-conversation',
        webAiAccountId: 'private-account'
      }
      const state = makeState({
        activeBrowserTabIdByWorktree: {
          'wt-1': ordinaryWorkspace.id,
          [webAiWorkspaceId]: webAiWorkspace.id
        },
        browserTabsByWorktree: {
          'wt-1': [ordinaryWorkspace],
          [webAiWorkspaceId]: [webAiWorkspace]
        },
        browserPagesByWorkspace: {
          [ordinaryWorkspace.id]: [
            {
              id: 'page-1',
              workspaceId: ordinaryWorkspace.id,
              worktreeId: 'wt-1',
              url: 'https://runtime-browser.example/session',
              title: 'Web Runtime Browser',
              loading: false,
              faviconUrl: null,
              canGoBack: true,
              canGoForward: false,
              loadError: null,
              createdAt: 1,
              browserRuntimeEnvironmentId: 'runtime-1'
            }
          ],
          [webAiWorkspace.id]: [
            {
              id: 'web-ai-page',
              workspaceId: webAiWorkspace.id,
              worktreeId: webAiWorkspaceId,
              url: 'https://chatgpt.com/c/private-conversation',
              title: 'Private Chat Title',
              loading: false,
              faviconUrl: null,
              canGoBack: false,
              canGoForward: false,
              loadError: null,
              createdAt: 1
            }
          ]
        } as unknown as AppState['browserPagesByWorkspace']
      })

      const snapshots = buildMobileSessionTabSnapshots(state)
      const browserProjection = getRuntimeMobileSessionSyncKey(state).browserProjection
      const serialized = JSON.stringify({ snapshots, browserProjection })

      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]).toMatchObject({
        worktree: 'wt-1',
        tabs: [
          {
            type: 'browser',
            browserWorkspaceId: ordinaryWorkspace.id,
            title: 'Web Runtime Browser',
            url: 'https://runtime-browser.example/session'
          }
        ]
      })
      expect(serialized).not.toContain('private-account')
      expect(serialized).not.toContain('web-ai-browser')
      expect(serialized).not.toContain('web-ai-page')
      expect(serialized).not.toContain('Private Chat Title')
      expect(serialized).not.toContain('private-conversation')
    }
  )

  it('filters account-bound browser state inside an ordinary worktree', () => {
    const publicWorkspace = makeBrowserWorkspace('Public Workspace')
    const privateWorkspace = {
      ...makeBrowserWorkspace('Private Workspace Title'),
      id: 'private-browser-workspace',
      activePageId: 'private-browser-page',
      pageIds: ['private-browser-page'],
      url: 'https://chatgpt.com/c/private-worktree-chat',
      webAiAccountId: 'private-account-id',
      sessionProfileId: 'private-profile-id',
      sessionPartition: 'persist:private-profile-id'
    }
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'public-unified-tab',
            tabOrder: ['private-unified-tab', 'public-unified-tab'],
            recentTabIds: ['private-unified-tab', 'public-unified-tab']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'private-unified-tab',
            groupId: 'group-1',
            contentType: 'browser',
            entityId: privateWorkspace.id,
            title: 'Private Unified Metadata'
          },
          {
            id: 'public-unified-tab',
            groupId: 'group-1',
            contentType: 'browser',
            entityId: publicWorkspace.id,
            title: 'Public Browser'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      browserTabsByWorktree: { 'wt-1': [privateWorkspace, publicWorkspace] },
      browserPagesByWorkspace: {
        [privateWorkspace.id]: [
          {
            id: 'private-browser-page',
            workspaceId: privateWorkspace.id,
            worktreeId: 'wt-1',
            url: 'https://chatgpt.com/c/private-worktree-chat',
            title: 'Private Page Title',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ],
        [publicWorkspace.id]: [
          {
            id: 'page-1',
            workspaceId: publicWorkspace.id,
            worktreeId: 'wt-1',
            url: 'https://example.com/public-page',
            title: 'Public Page Title',
            loading: false,
            faviconUrl: null,
            canGoBack: true,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as unknown as AppState['browserPagesByWorkspace']
    })

    const snapshots = buildMobileSessionTabSnapshots(state)
    const browserProjection = getRuntimeMobileSessionSyncKey(state).browserProjection
    const serialized = JSON.stringify({ snapshots, browserProjection })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      worktree: 'wt-1',
      activeTabId: 'public-unified-tab',
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: 'public-unified-tab',
          tabOrder: ['public-unified-tab'],
          recentTabIds: ['public-unified-tab']
        }
      ],
      tabs: [
        {
          type: 'browser',
          id: 'public-unified-tab',
          browserWorkspaceId: publicWorkspace.id,
          browserPageId: 'page-1',
          title: 'Public Page Title',
          url: 'https://example.com/public-page'
        }
      ]
    })
    expect(serialized).not.toContain('private-account-id')
    expect(serialized).not.toContain('private-browser-workspace')
    expect(serialized).not.toContain('private-browser-page')
    expect(serialized).not.toContain('private-worktree-chat')
    expect(serialized).not.toContain('Private Workspace Title')
    expect(serialized).not.toContain('Private Page Title')
    expect(serialized).not.toContain('private-unified-tab')
    expect(serialized).not.toContain('Private Unified Metadata')
  })
})
