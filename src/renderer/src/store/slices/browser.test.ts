/* eslint-disable max-lines -- Why: browser slice behavior shares one mocked store harness; splitting only the tests would duplicate more setup than it saves. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createBrowserSlice } from './browser'
import type { AppState } from '../types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const mockApi = {
  browser: {
    sessionListProfiles: vi.fn().mockResolvedValue([]),
    sessionCreateProfile: vi.fn().mockResolvedValue(null),
    sessionDeleteProfile: vi.fn().mockResolvedValue(false),
    sessionImportCookies: vi.fn().mockResolvedValue({ ok: false, reason: 'canceled' }),
    sessionDetectBrowsers: vi.fn().mockResolvedValue([]),
    sessionImportFromBrowser: vi.fn().mockResolvedValue({ ok: false, reason: 'canceled' }),
    sessionClearDefaultCookies: vi.fn().mockResolvedValue(false),
    notifyActiveTabChanged: vi.fn().mockResolvedValue(undefined)
  },
  runtimeEnvironments: {
    call: runtimeEnvironmentTransportCall
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
        activeWorktreeId: 'wt-1',
        browserDefaultUrl: 'about:blank',
        unifiedTabsByWorktree: {},
        tabBarOrderByWorktree: {},
        tabsByWorktree: {},
        openFiles: [],
        activeTabType: 'terminal',
        activeTabTypeByWorktree: {},
        worktreesByRepo: {},
        createUnifiedTab: vi.fn(),
        closeUnifiedTab: vi.fn(),
        activateTab: vi.fn(),
        setTabLabel: vi.fn(),
        recordFeatureInteraction: vi.fn(),
        ...createBrowserSlice(...a)
      }) as unknown as AppState
  )
}

function settingsWithRuntime(id: string): AppState['settings'] {
  return { activeRuntimeEnvironmentId: id } as AppState['settings']
}

function seedUnifiedBrowserTab(
  store: ReturnType<typeof createTestStore>,
  entityId: string,
  label: string
): void {
  store.setState({
    unifiedTabsByWorktree: {
      'wt-1': [
        {
          id: 'unified-browser-tab',
          entityId,
          groupId: 'group-1',
          worktreeId: 'wt-1',
          contentType: 'browser',
          label,
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    }
  })
}

function makeAnnotation(pageId: string, id = 'annotation-1'): BrowserPageAnnotation {
  return {
    id,
    browserPageId: pageId,
    comment: 'Fix this button',
    intent: 'fix',
    priority: 'important',
    createdAt: '2026-05-15T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'https://example.com',
        title: 'Example',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-05-15T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: 'button',
        textSnippet: 'Submit',
        htmlSnippet: '<button>Submit</button>',
        attributes: {},
        accessibility: {
          role: 'button',
          accessibleName: 'Submit',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 0, y: 0, width: 100, height: 40 },
        rectPage: { x: 0, y: 0, width: 100, height: 40 },
        computedStyles: {
          display: 'inline-flex',
          position: 'static',
          width: '100px',
          height: '40px',
          margin: '0px',
          padding: '0px',
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          border: '0px none',
          borderRadius: '0px',
          fontFamily: 'Geist',
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '20px',
          textAlign: 'center',
          zIndex: 'auto'
        }
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

describe('createBrowserSlice annotations', () => {
  it('records browser-tab-created only for the explicit new-tab action', async () => {
    const store = createTestStore()

    store.getState().createBrowserTab('wt-1', 'https://example.com')
    expect(store.getState().recordFeatureInteraction).not.toHaveBeenCalledWith(
      'browser-tab-created'
    )

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(store.getState().recordFeatureInteraction).toHaveBeenCalledWith('browser-tab-created')
  })

  it('clears page annotations when the browser page URL changes', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }

    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))
    expect(store.getState().browserAnnotationsByPageId[pageId]).toHaveLength(1)

    store.getState().setBrowserPageUrl(pageId, 'https://example.com/next')

    expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
  })

  it('creates inactive browser unified tabs without stealing the visible tab', () => {
    const store = createTestStore()

    store.getState().createBrowserTab('wt-1', 'https://example.com', { activate: false })

    expect(store.getState().createUnifiedTab).toHaveBeenCalledWith(
      'wt-1',
      'browser',
      expect.objectContaining({ activate: false })
    )
    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeBrowserTabIdByWorktree['wt-1']).toBeNull()
  })

  it('preserves browser map references when a page-state update is unchanged', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const page = store.getState().browserPagesByWorkspace[tab.id]?.[0]
    if (!page) {
      throw new Error('Expected page state')
    }
    const browserPagesByWorkspace = store.getState().browserPagesByWorkspace
    const browserTabsByWorktree = store.getState().browserTabsByWorktree

    store.getState().updateBrowserPageState(pageId, {
      title: page.title,
      loading: page.loading,
      faviconUrl: page.faviconUrl,
      canGoBack: page.canGoBack,
      canGoForward: page.canGoForward,
      loadError: page.loadError
    })

    expect(store.getState().browserPagesByWorkspace).toBe(browserPagesByWorkspace)
    expect(store.getState().browserTabsByWorktree).toBe(browserTabsByWorktree)
  })

  it('repairs a stale active browser unified-tab label on an otherwise unchanged title update', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    seedUnifiedBrowserTab(store, tab.id, 'Stale label')
    const browserPagesByWorkspace = store.getState().browserPagesByWorkspace
    const browserTabsByWorktree = store.getState().browserTabsByWorktree

    store.getState().updateBrowserPageState(pageId, { title: 'Example' })

    expect(store.getState().unifiedTabsByWorktree['wt-1']?.[0]?.label).toBe('Example')
    expect(store.getState().browserPagesByWorkspace).toBe(browserPagesByWorkspace)
    expect(store.getState().browserTabsByWorktree).toBe(browserTabsByWorktree)
  })

  it('repairs stale active browser workspace metadata on an otherwise unchanged page update', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    store.setState((state) => ({
      browserTabsByWorktree: {
        ...state.browserTabsByWorktree,
        'wt-1': (state.browserTabsByWorktree['wt-1'] ?? []).map((workspace) =>
          workspace.id === tab.id
            ? {
                ...workspace,
                title: 'Stale workspace',
                url: 'https://stale.example.com',
                loading: false,
                canGoBack: true,
                canGoForward: true
              }
            : workspace
        )
      }
    }))
    const browserPagesByWorkspace = store.getState().browserPagesByWorkspace

    store.getState().updateBrowserPageState(pageId, { title: 'Example' })

    const repaired = store
      .getState()
      .browserTabsByWorktree['wt-1']?.find((entry) => entry.id === tab.id)
    expect(repaired).toMatchObject({
      title: 'Example',
      url: 'https://example.com',
      loading: true,
      canGoBack: false,
      canGoForward: false
    })
    expect(store.getState().browserPagesByWorkspace).toBe(browserPagesByWorkspace)
  })

  it('updates the active browser unified-tab label without a second tab-label write', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    seedUnifiedBrowserTab(store, tab.id, 'Example')

    store.getState().updateBrowserPageState(pageId, { title: 'Next', loading: false })

    expect(store.getState().unifiedTabsByWorktree['wt-1']?.[0]?.label).toBe('Next')
    expect(store.getState().setTabLabel).not.toHaveBeenCalled()
  })

  it('updates inactive browser pages without relabeling or rebuilding the workspace map', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    const activePageId = tab.activePageId
    if (!activePageId) {
      throw new Error('Expected a new browser page')
    }
    const inactivePage = store
      .getState()
      .createBrowserPage(tab.id, 'https://example.com/inactive', {
        title: 'Inactive',
        activate: false
      })
    if (!inactivePage) {
      throw new Error('Expected inactive browser page')
    }
    seedUnifiedBrowserTab(store, tab.id, 'Example')
    const browserPagesByWorkspace = store.getState().browserPagesByWorkspace
    const browserTabsByWorktree = store.getState().browserTabsByWorktree

    store.getState().updateBrowserPageState(inactivePage.id, {
      title: 'Inactive next',
      loading: false
    })

    expect(store.getState().browserPagesByWorkspace).not.toBe(browserPagesByWorkspace)
    expect(store.getState().browserTabsByWorktree).toBe(browserTabsByWorktree)
    expect(
      store.getState().browserPagesByWorkspace[tab.id]?.find((page) => page.id === inactivePage.id)
    ).toMatchObject({ title: 'Inactive next', loading: false })
    expect(store.getState().browserTabsByWorktree['wt-1']?.[0]).toMatchObject({
      activePageId,
      title: 'Example'
    })
    expect(store.getState().unifiedTabsByWorktree['wt-1']?.[0]?.label).toBe('Example')
    expect(store.getState().setTabLabel).not.toHaveBeenCalled()
  })

  it('caps stored browser annotations per page', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }

    for (let index = 0; index < GRAB_BUDGET.annotationsMaxPerPage + 3; index++) {
      store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, `annotation-${index}`))
    }

    const annotations = store.getState().browserAnnotationsByPageId[pageId] ?? []
    expect(annotations).toHaveLength(GRAB_BUDGET.annotationsMaxPerPage)
    expect(annotations[0]?.id).toBe('annotation-3')
  })

  it('sanitizes persistent annotation payloads at the store boundary', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const annotation = makeAnnotation(pageId)
    const oversizedComment = 'a'.repeat(GRAB_BUDGET.annotationCommentMaxLength + 10)

    store.getState().addBrowserPageAnnotation({
      ...annotation,
      comment: oversizedComment,
      payload: {
        ...annotation.payload,
        screenshot: {
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
          width: 1,
          height: 1
        }
      } as unknown as BrowserPageAnnotation['payload']
    })

    const stored = store.getState().browserAnnotationsByPageId[pageId]?.[0]
    expect(stored?.comment).toHaveLength(GRAB_BUDGET.annotationCommentMaxLength)
    expect(stored?.payload.screenshot).toBeNull()
  })
})

describe('createBrowserSlice floating tabs', () => {
  it('tracks new floating browser tabs without changing the main browser surface', () => {
    const store = createTestStore()
    store.setState({ activeWorktreeId: 'wt-1', activeTabType: 'terminal' } as Partial<AppState>)
    const mainTab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const activeTabTypeBeforeFloating = store.getState().activeTabType

    const tab = store.getState().createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, 'about:blank', {
      focusAddressBar: true
    })

    expect(store.getState().activeBrowserTabId).toBe(mainTab.id)
    expect(store.getState().activeBrowserTabIdByWorktree['wt-1']).toBe(mainTab.id)
    expect(store.getState().activeBrowserTabIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toBe(
      tab.id
    )
    expect(store.getState().pendingAddressBarFocusByTabId[tab.id]).toBe(true)
    expect(store.getState().activeTabType).toBe(activeTabTypeBeforeFloating)
  })
})

describe('createBrowserSlice closed browser workspaces', () => {
  it('reopens duplicate-URL browser pages on the originally active page', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com/dashboard', {
      title: 'First copy'
    })
    const secondPage = store.getState().createBrowserPage(tab.id, 'https://example.com/dashboard', {
      title: 'Second copy'
    })
    if (!secondPage) {
      throw new Error('Expected a second browser page')
    }

    store.getState().closeBrowserTab(tab.id)
    const restored = store.getState().reopenClosedBrowserTab('wt-1')
    if (!restored) {
      throw new Error('Expected a reopened browser workspace')
    }
    const restoredPages = store.getState().browserPagesByWorkspace[restored.id] ?? []
    const activePage = restoredPages.find((page) => page.id === restored.activePageId)

    expect(restoredPages.map((page) => page.url)).toEqual([
      'https://example.com/dashboard',
      'https://example.com/dashboard'
    ])
    expect(activePage?.title).toBe('Second copy')
  })
})

describe('createBrowserSlice runtime guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    runtimeEnvironmentCall.mockResolvedValue({ id: 'rpc-1', ok: true, result: {} })
  })

  it('fetches browser profiles from the active runtime environment', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        profiles: [
          {
            id: 'default',
            scope: 'default',
            partition: 'persist:orca-default',
            label: 'Default',
            source: null
          }
        ]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserSessionProfiles: []
    })

    await store.getState().fetchBrowserSessionProfiles()

    expect(mockApi.browser.sessionListProfiles).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'browser.profileList',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(store.getState().browserSessionProfiles).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
  })

  it('does not import local browser cookies while a runtime environment is active', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })

    const result = await store.getState().importCookiesToProfile('default')

    expect(mockApi.browser.sessionImportCookies).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(store.getState().browserSessionImportState).toMatchObject({
      profileId: 'default',
      status: 'error'
    })
  })

  it('uses local browser IPC when no runtime environment is active', async () => {
    const store = createTestStore()
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])

    await store.getState().fetchBrowserSessionProfiles()

    expect(mockApi.browser.sessionListProfiles).toHaveBeenCalledTimes(1)
    expect(store.getState().browserSessionProfiles).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
  })

  it('does not notify the local browser manager when selecting tabs under runtime', () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      unifiedTabsByWorktree: {},
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'about:blank',
            title: 'New Tab',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      }
    })

    store.getState().setActiveBrowserTab('workspace-1')

    expect(mockApi.browser.notifyActiveTabChanged).not.toHaveBeenCalled()
  })

  it('closes the mapped remote tab when closing a browser page in the active runtime', async () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserPage('page-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toBeUndefined()
  })

  it('closes mapped remote tabs when closing a browser workspace in the active runtime', async () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabId: 'workspace-1',
      activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserTab('workspace-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toBeUndefined()
  })

  it('closes mapped remote pages in their owning environment after switching local', async () => {
    const store = createTestStore()
    store.setState({
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserPage('page-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
  })

  it('closes mapped remote tabs in their owning environment after switching environments', async () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-2'),
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserTab('workspace-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
  })
})
