import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  createBrowserMockApi,
  createTestStore,
  settingsWithRuntime
} from './browser-slice-test-harness'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

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
  it('announces the store-selected browser page before its guest is destroyed', () => {
    const store = createTestStore()
    const previous = store.getState().createBrowserTab('wt-1', 'https://previous.example.com')
    const closing = store.getState().createBrowserTab('wt-1', 'https://closing.example.com')
    store.getState().setActiveBrowserTab(previous.id)
    store.getState().setActiveBrowserTab(closing.id)
    mockApi.browser.notifyActiveTabChanged.mockClear()

    store.getState().closeBrowserTab(closing.id)

    expect(mockApi.browser.notifyActiveTabChanged).toHaveBeenCalledWith({
      browserPageId: previous.activePageId
    })
  })

  it('keeps a requested canonical page identity distinct from its workspace', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserPageId: 'page-canonical'
    })

    expect(tab.id).not.toBe('page-canonical')
    expect(tab.activePageId).toBe('page-canonical')
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id).toBe('page-canonical')
    expect(() =>
      store.getState().createBrowserTab('wt-1', 'about:blank', {
        browserPageId: 'page-canonical'
      })
    ).toThrow('Browser page page-canonical already exists')
  })

  it('records browser-tab-created only for the explicit new-tab action', async () => {
    const store = createTestStore()

    store.getState().createBrowserTab('wt-1', 'https://example.com')
    expect(store.getState().recordFeatureInteraction).not.toHaveBeenCalledWith(
      'browser-tab-created'
    )

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(store.getState().recordFeatureInteraction).toHaveBeenCalledWith('browser-tab-created')
  })

  it('opens a local sign-in tab with the imported browser profile', async () => {
    const store = createTestStore()

    await expect(
      store
        .getState()
        .openBrowserProfileTabInActiveWorkspace('https://accounts.google.com/', 'profile-1')
    ).resolves.toBe(true)

    expect(store.getState().browserTabsByWorktree['wt-1']?.[0]).toMatchObject({
      url: 'https://accounts.google.com/',
      sessionProfileId: 'profile-1'
    })
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

  it('can commit a navigation URL without hiding an active recovery error', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const recoveryError = {
      code: -720,
      description: 'Recovery is still pending',
      validatedUrl: 'https://example.com'
    }

    store.getState().updateBrowserPageState(pageId, { loadError: recoveryError })
    store
      .getState()
      .setBrowserPageUrl(pageId, 'https://example.com/committed', { preserveLoadError: true })

    const page = store.getState().browserPagesByWorkspace[tab.id]?.find(({ id }) => id === pageId)
    expect(page).toMatchObject({
      url: 'https://example.com/committed',
      loadError: recoveryError
    })
  })

  it('keeps certificate challenges transient across navigation, success, and close', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://localhost:3443/')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const failure = {
      challengeId: 'challenge-1',
      browserPageId: pageId,
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      canProceed: true,
      observedAt: 123
    }

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toEqual(failure)

    store.getState().setBrowserPageUrl(pageId, 'https://localhost:3443/next')
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    store.getState().updateBrowserPageState(pageId, { loadError: null })
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    store.getState().closeBrowserTab(tab.id)
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()
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

  it('uses local browser profile defaults for client-local fallback pages', () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      defaultBrowserSessionProfileIdByHostId: {
        local: 'local-profile',
        'runtime:env-1': 'runtime-profile'
      }
    })

    const localFallback = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserRuntimeEnvironmentId: null
    })
    const remoteTab = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserRuntimeEnvironmentId: 'env-1'
    })

    expect(localFallback.sessionProfileId).toBe('local-profile')
    expect(remoteTab.sessionProfileId).toBe('runtime-profile')
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

  it('persists a captured favicon with history and refreshes it with the page state', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const initialFavicon = 'https://example.com/favicon.ico'
    const refreshedFavicon = 'https://cdn.example.com/favicon.png'

    store.getState().addBrowserHistoryEntry('https://example.com', 'Example', initialFavicon)
    expect(store.getState().browserUrlHistory[0]?.faviconUrl).toBe(initialFavicon)

    store.getState().updateBrowserPageState(pageId, { faviconUrl: refreshedFavicon })
    expect(store.getState().browserUrlHistory[0]?.faviconUrl).toBe(refreshedFavicon)
  })

  it('clears a stale history favicon when a page reports none, and keeps it when none is reported', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const favicon = 'https://example.com/favicon.ico'

    store.getState().addBrowserHistoryEntry('https://example.com', 'Example', favicon)
    store.getState().updateBrowserPageState(pageId, { faviconUrl: favicon })

    // An omitted favicon leaves the stored one alone; an explicit null clears it.
    store.getState().addBrowserHistoryEntry('https://example.com', 'Example')
    expect(store.getState().browserUrlHistory[0]?.faviconUrl).toBe(favicon)

    store.getState().updateBrowserPageState(pageId, { faviconUrl: null })
    expect(store.getState().browserUrlHistory[0]?.faviconUrl).toBeNull()

    store.getState().addBrowserHistoryEntry('https://example.com', 'Example', favicon)
    expect(store.getState().browserUrlHistory[0]?.faviconUrl).toBe(favicon)

    store.getState().addBrowserHistoryEntry('https://example.com', 'Example', null)
    expect(store.getState().browserUrlHistory[0]?.faviconUrl).toBeNull()
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

  it('updates an existing annotation comment and intent', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))

    store
      .getState()
      .updateBrowserPageAnnotation(pageId, 'annotation-1', { comment: 'Updated', intent: 'change' })

    const stored = store.getState().browserAnnotationsByPageId[pageId]?.[0]
    expect(stored?.comment).toBe('Updated')
    expect(stored?.intent).toBe('change')
  })

  it('sanitizes an oversized comment when updating an annotation', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))
    const oversizedComment = 'a'.repeat(GRAB_BUDGET.annotationCommentMaxLength + 10)

    store.getState().updateBrowserPageAnnotation(pageId, 'annotation-1', {
      comment: oversizedComment,
      intent: 'fix'
    })

    const stored = store.getState().browserAnnotationsByPageId[pageId]?.[0]
    expect(stored?.comment).toHaveLength(GRAB_BUDGET.annotationCommentMaxLength)
  })

  it('is a no-op when updating an annotation id that does not exist', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))
    const stateBefore = store.getState()

    store.getState().updateBrowserPageAnnotation(pageId, 'missing-annotation', {
      comment: 'Updated',
      intent: 'change'
    })

    expect(store.getState()).toBe(stateBefore)
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
