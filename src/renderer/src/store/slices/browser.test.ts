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
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  getDefaultWorkspaceSession,
  getWebAiAccountWorkspaceId
} from '../../../../shared/constants'
import type { WebAiAccount } from '../../../../shared/types'
import { buildBrowserSessionData } from '@/lib/workspace-session'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

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
  const store = create<AppState>()(
    (...a) =>
      ({
        settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
        activeView: 'terminal',
        activeWorktreeId: 'wt-1',
        folderWorkspaces: [],
        browserDefaultUrl: 'about:blank',
        unifiedTabsByWorktree: {},
        tabBarOrderByWorktree: {},
        tabsByWorktree: {},
        openFiles: [],
        activeTabType: 'terminal',
        activeTabTypeByWorktree: {},
        isNavigatingHistory: false,
        worktreesByRepo: {},
        createUnifiedTab: vi.fn(),
        closeUnifiedTab: vi.fn(),
        activateTab: vi.fn(),
        setTabLabel: vi.fn(),
        recordFeatureInteraction: vi.fn(),
        ...createBrowserSlice(...a)
      }) as unknown as AppState
  )
  store.setState({
    setActiveView: vi.fn((activeView) => store.setState({ activeView })),
    setActiveWorktree: vi.fn((activeWorktreeId) => store.setState({ activeWorktreeId })),
    recordWorktreeVisit: vi.fn(),
    updateSettings: vi.fn(async (updates) => {
      const next = { ...store.getState().settings!, ...updates }
      store.setState({ settings: next })
      return next
    })
  })
  return store
}

function webAiAccount(overrides: Partial<WebAiAccount> = {}): WebAiAccount {
  return {
    id: 'web-ai-account-1',
    provider: 'chatgpt',
    label: 'Personal ChatGPT',
    executionHostId: 'local',
    profileId: 'profile-isolated',
    sessionPartition: 'persist:orca-browser-session-profile-isolated',
    createdAt: 1,
    ...overrides
  }
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

describe('createBrowserSlice Web AI accounts', () => {
  it('does not launch when the saved profile id and partition no longer exist', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: account.profileId,
        scope: 'isolated',
        partition: 'persist:changed-partition',
        label: 'Changed profile',
        source: null
      }
    ])

    const result = await store.getState().launchWebAiAccount(account)

    expect(result).toMatchObject({ ok: false, reason: 'profile-missing' })
    expect(store.getState().browserTabsByWorktree[getWebAiAccountWorkspaceId(account.id)]).toBe(
      undefined
    )
  })

  it('launches after the authoritative local profile id and partition match', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: account.profileId,
        scope: 'isolated',
        partition: account.sessionPartition,
        label: 'Personal browser',
        source: null
      }
    ])

    const result = await store.getState().launchWebAiAccount(account)

    expect(result.ok).toBe(true)
    expect(
      store.getState().browserTabsByWorktree[getWebAiAccountWorkspaceId(account.id)]
    ).toHaveLength(1)
  })

  it('keeps the remote profile mirror focused while a Web AI launch refreshes local profiles', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    const remoteProfiles = [
      {
        id: 'remote-default',
        scope: 'default' as const,
        partition: 'persist:remote-default',
        label: 'Remote Default',
        source: null
      }
    ]
    const localProfiles = [
      {
        id: account.profileId,
        scope: 'isolated' as const,
        partition: account.sessionPartition,
        label: 'Local Web AI profile',
        source: null
      }
    ]
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: 'env-1',
        webAiAccounts: [account]
      } as AppState['settings'],
      browserSessionProfiles: remoteProfiles,
      browserSessionProfilesByHostId: { 'runtime:env-1': remoteProfiles }
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce(localProfiles)

    const result = await store.getState().launchWebAiAccount(account)

    expect(result.ok).toBe(true)
    expect(store.getState().browserSessionProfiles).toEqual(remoteProfiles)
    expect(store.getState().browserSessionProfilesByHostId.local).toEqual(localProfiles)
    expect(store.getState().browserSessionProfilesByHostId['runtime:env-1']).toEqual(remoteProfiles)
  })

  it('does not let a stale caller substitute another profile for a saved account id', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    const staleAccount = webAiAccount({
      profileId: 'profile-substitute',
      sessionPartition: 'persist:profile-substitute'
    })
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: staleAccount.profileId,
        scope: 'isolated',
        partition: staleAccount.sessionPartition,
        label: 'Substitute profile',
        source: null
      }
    ])

    const result = await store.getState().launchWebAiAccount(staleAccount)

    expect(result).toMatchObject({ ok: false, reason: 'profile-missing' })
    expect(store.getState().browserTabsByWorktree[getWebAiAccountWorkspaceId(account.id)]).toBe(
      undefined
    )
  })

  it('removes an old account binding before reporting the canonical profile missing', async () => {
    const store = createTestStore()
    const account = webAiAccount({
      profileId: 'profile-new',
      sessionPartition: 'persist:profile-new'
    })
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const staleWorkspace = store
      .getState()
      .createBrowserTab(accountWorkspaceId, 'https://chatgpt.com/', {
        sessionProfileId: 'profile-old',
        sessionPartition: 'persist:profile-old',
        webAiAccountId: account.id
      })
    store.setState({
      unifiedTabsByWorktree: {
        [accountWorkspaceId]: [
          {
            id: 'old-binding-unified-tab',
            entityId: staleWorkspace.id,
            groupId: 'group-1',
            worktreeId: accountWorkspaceId,
            contentType: 'browser',
            label: 'Old ChatGPT binding',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: 'profile-old',
        scope: 'isolated',
        partition: 'persist:profile-old',
        label: 'Old profile',
        source: null
      }
    ])

    const result = await store.getState().launchWebAiAccount(account)

    expect(result).toMatchObject({ ok: false, reason: 'profile-missing' })
    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]).toBeUndefined()
    expect(store.getState().browserPagesByWorkspace[staleWorkspace.id]).toBeUndefined()
    expect(store.getState().closeUnifiedTab).toHaveBeenCalledWith('old-binding-unified-tab')
  })

  it('creates an isolated projectless workspace and reuses it on later clicks', () => {
    const store = createTestStore()
    store.setState({ activeWorktreeId: null, worktreesByRepo: {} })
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)

    const created = store.getState().openWebAiAccount(account)
    const focused = store.getState().openWebAiAccount(account)

    expect(created).toMatchObject({
      worktreeId: accountWorkspaceId,
      sessionProfileId: account.profileId,
      sessionPartition: account.sessionPartition,
      webAiAccountId: account.id,
      url: 'https://chatgpt.com/'
    })
    expect(focused?.id).toBe(created?.id)
    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]).toHaveLength(1)
    expect(store.getState().setActiveWorktree).toHaveBeenCalledWith(accountWorkspaceId)
    expect(store.getState().setActiveView).toHaveBeenCalledWith('terminal')
    expect(store.getState().recordWorktreeVisit).toHaveBeenCalledTimes(1)
  })

  it('opens a Custom account at its own HTTPS home instead of ChatGPT', () => {
    const store = createTestStore()
    const account = webAiAccount({
      provider: 'custom',
      label: 'Personal Doubao',
      customServiceLabel: 'Doubao',
      customHomeUrl: 'https://www.doubao.com/chat/',
      customCookieDomains: ['doubao.com']
    })

    const created = store.getState().openWebAiAccount(account)

    expect(created?.url).toBe('https://www.doubao.com/chat/')
    expect(created?.url).not.toBe('https://chatgpt.com/')
  })

  it('opens Google AI Studio at its fixed provider home', () => {
    const store = createTestStore()
    const account = webAiAccount({
      provider: 'aistudio',
      label: 'Work AI Studio'
    })

    expect(store.getState().openWebAiAccount(account)?.url).toBe('https://aistudio.google.com/')
  })

  it('opens additional visible browser tabs with the same account identity', () => {
    const store = createTestStore()
    const account = webAiAccount({ provider: 'claude' })
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }

    const result = store.getState().openWebAiAccount(account, { openNewTab: true })

    expect(result?.id).not.toBe(workspace.id)
    const workspaces = store.getState().browserTabsByWorktree[accountWorkspaceId] ?? []
    expect(workspaces).toHaveLength(2)
    expect(workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          webAiAccountId: account.id,
          sessionProfileId: account.profileId,
          sessionPartition: account.sessionPartition,
          url: 'https://claude.ai/'
        }),
        expect.objectContaining({
          webAiAccountId: account.id,
          sessionProfileId: account.profileId,
          sessionPartition: account.sessionPartition,
          url: 'https://claude.ai/'
        })
      ])
    )
    expect(
      workspaces.every((entry) => store.getState().browserPagesByWorkspace[entry.id]?.length === 1)
    ).toBe(true)
  })

  it('keeps different saved accounts in separate workspaces and profile partitions', () => {
    const store = createTestStore()
    const personal = webAiAccount()
    const work = webAiAccount({
      id: 'web-ai-account-2',
      provider: 'deepseek',
      label: 'Work DeepSeek',
      profileId: 'profile-work',
      sessionPartition: 'persist:orca-browser-session-profile-work'
    })
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [personal, work]
      } as AppState['settings']
    })

    const personalTab = store.getState().openWebAiAccount(personal)
    const workTab = store.getState().openWebAiAccount(work)
    const personalAgain = store.getState().openWebAiAccount(personal)
    const personalWorkspaceId = getWebAiAccountWorkspaceId(personal.id)
    const workWorkspaceId = getWebAiAccountWorkspaceId(work.id)

    expect(personalAgain?.id).toBe(personalTab?.id)
    expect(workTab).toMatchObject({
      webAiAccountId: work.id,
      sessionProfileId: work.profileId,
      sessionPartition: work.sessionPartition
    })
    expect(store.getState().browserTabsByWorktree[personalWorkspaceId]).toEqual([personalTab])
    expect(store.getState().browserTabsByWorktree[workWorkspaceId]).toEqual([workTab])
  })

  it('switches between accounts without sharing their persistent partitions', () => {
    const store = createTestStore()
    const personal = webAiAccount()
    const work = webAiAccount({
      id: 'web-ai-account-2',
      label: 'Work ChatGPT',
      profileId: 'profile-work',
      sessionPartition: 'persist:orca-browser-session-profile-work'
    })

    const personalWorkspace = store.getState().openWebAiAccount(personal)
    const workWorkspace = store.getState().openWebAiAccount(work)
    const focusedPersonal = store.getState().openWebAiAccount(personal)
    const personalWorkspaceId = getWebAiAccountWorkspaceId(personal.id)
    const workWorkspaceId = getWebAiAccountWorkspaceId(work.id)

    expect(personalWorkspace).toMatchObject({
      webAiAccountId: personal.id,
      sessionProfileId: personal.profileId,
      sessionPartition: personal.sessionPartition
    })
    expect(workWorkspace).toMatchObject({
      webAiAccountId: work.id,
      sessionProfileId: work.profileId,
      sessionPartition: work.sessionPartition
    })
    expect(personal.sessionPartition).not.toBe(work.sessionPartition)
    expect(focusedPersonal?.id).toBe(personalWorkspace?.id)
    expect(store.getState().activeBrowserTabId).toBe(personalWorkspace?.id)
    expect(store.getState().activeWorktreeId).toBe(personalWorkspaceId)
    expect(store.getState().browserTabsByWorktree[personalWorkspaceId]).toEqual([personalWorkspace])
    expect(store.getState().browserTabsByWorktree[workWorkspaceId]).toEqual([workWorkspace])
  })

  it('routes the generic new-browser action to another visible tab in the active account identity', async () => {
    const store = createTestStore()
    const account = webAiAccount({ provider: 'deepseek' })
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: account.profileId,
        scope: 'isolated',
        partition: account.sessionPartition,
        label: 'DeepSeek profile',
        source: null
      }
    ])

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    const workspaces = store.getState().browserTabsByWorktree[accountWorkspaceId] ?? []
    expect(workspaces).toHaveLength(2)
    expect(workspaces[1]).toMatchObject({
      url: 'https://chat.deepseek.com/',
      webAiAccountId: account.id,
      sessionProfileId: account.profileId,
      sessionPartition: account.sessionPartition
    })
    expect(store.getState().browserPagesByWorkspace[workspace.id]).toHaveLength(1)
    expect(store.getState().browserPagesByWorkspace[workspaces[1]!.id]).toHaveLength(1)
  })

  it('does not open a new account tab when the saved profile binding is missing', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: account.profileId,
        scope: 'isolated',
        partition: 'persist:changed-partition',
        label: 'Changed profile',
        source: null
      }
    ])

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]).toEqual([workspace])
  })

  it('replaces a drifted active account tab when opening a new tab', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const drifted = store.getState().createBrowserTab(accountWorkspaceId, 'https://chatgpt.com/', {
      sessionProfileId: 'profile-old',
      sessionPartition: 'persist:profile-old',
      webAiAccountId: account.id
    })
    store.setState({
      activeWorktreeId: accountWorkspaceId,
      activeBrowserTabId: drifted.id,
      activeBrowserTabIdByWorktree: { [accountWorkspaceId]: drifted.id }
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: account.profileId,
        scope: 'isolated',
        partition: account.sessionPartition,
        label: 'Canonical profile',
        source: null
      }
    ])

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    const workspaces = store.getState().browserTabsByWorktree[accountWorkspaceId] ?? []
    expect(workspaces).toEqual([
      expect.objectContaining({
        webAiAccountId: account.id,
        sessionProfileId: account.profileId,
        sessionPartition: account.sessionPartition
      })
    ])
    expect(workspaces[0]?.id).not.toBe(drifted.id)
    expect(store.getState().browserPagesByWorkspace[drifted.id]).toBeUndefined()
  })

  it('opens guest-requested links in a visible tab with the source account profile', () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const source = store.getState().openWebAiAccount(account)
    if (!source?.activePageId) {
      throw new Error('Expected a Web AI browser page')
    }

    const opened = store
      .getState()
      .openBrowserLinkInNewTab(source.activePageId, 'https://chatgpt.com/c/example')

    expect(opened).toMatchObject({
      url: 'https://chatgpt.com/c/example',
      webAiAccountId: account.id,
      sessionProfileId: account.profileId,
      sessionPartition: account.sessionPartition
    })
    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]).toHaveLength(2)
  })

  it('removes stale profile workspaces before recreating the account surface', () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    const drifted = store.getState().createBrowserTab(accountWorkspaceId, 'https://chatgpt.com/', {
      sessionProfileId: 'different-profile',
      sessionPartition: 'persist:different-profile',
      webAiAccountId: account.id
    })
    store.setState({
      unifiedTabsByWorktree: {
        [accountWorkspaceId]: [
          {
            id: 'drifted-unified-tab',
            entityId: drifted.id,
            groupId: 'group-1',
            worktreeId: accountWorkspaceId,
            contentType: 'browser',
            label: 'Drifted ChatGPT',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })

    const created = store.getState().openWebAiAccount(account)
    const workspaces = store.getState().browserTabsByWorktree[accountWorkspaceId] ?? []

    expect(created?.id).not.toBe(drifted.id)
    expect(workspaces).toEqual([created])
    expect(workspaces).toEqual([
      expect.objectContaining({
        sessionProfileId: account.profileId,
        sessionPartition: account.sessionPartition,
        webAiAccountId: account.id
      })
    ])
    expect(store.getState().browserPagesByWorkspace[drifted.id]).toBeUndefined()
    expect(store.getState().closeUnifiedTab).toHaveBeenCalledWith('drifted-unified-tab')
  })

  it('preserves the account tag when reopening a closed workspace', () => {
    const store = createTestStore()
    const account = webAiAccount({ provider: 'deepseek' })
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }

    store.getState().closeBrowserTab(workspace.id)
    const reopened = store.getState().reopenClosedBrowserTab(accountWorkspaceId)

    expect(reopened?.webAiAccountId).toBe(account.id)
    expect(reopened?.sessionProfileId).toBe(account.profileId)
  })

  it('does not restore a synthetic tab after the saved account was removed', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }

    await store.getState().deleteWebAiAccount(account.id)
    const reopened = store.getState().reopenClosedBrowserTab(accountWorkspaceId)

    expect(reopened).toBeNull()
  })

  it('preserves the account tag when reopening another visible tab for the same account', () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const first = store.getState().openWebAiAccount(account)
    if (!first) {
      throw new Error('Expected a Web AI browser workspace')
    }
    store.getState().closeBrowserTab(first.id)
    const live = store.getState().openWebAiAccount(account)
    if (!live) {
      throw new Error('Expected a replacement Web AI browser workspace')
    }

    const reopened = store.getState().reopenClosedBrowserTab(accountWorkspaceId)

    expect(reopened?.webAiAccountId).toBe(account.id)
    expect(live.webAiAccountId).toBe(account.id)
  })

  it('leaves the empty synthetic workspace after its last browser closes', () => {
    const store = createTestStore()
    const account = webAiAccount()
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }

    store.getState().closeBrowserTab(workspace.id)

    expect(store.getState().activeWorktreeId).toBeNull()
  })

  it('removes the saved account and closes its surface without deleting the profile', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }
    store.getState().openWebAiAccount(account, { openNewTab: true })

    const removed = await store.getState().deleteWebAiAccount(account.id)

    expect(removed).toBe(true)
    expect(store.getState().settings?.webAiAccounts).toEqual([])
    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]).toBeUndefined()
    expect(mockApi.browser.sessionDeleteProfile).not.toHaveBeenCalled()
  })

  it('keeps the workspace binding when account persistence fails', async () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings'],
      updateSettings: vi.fn(async () => {})
    })
    const workspace = store.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }

    const removed = await store.getState().deleteWebAiAccount(account.id)

    expect(removed).toBe(false)
    expect(store.getState().settings?.webAiAccounts).toEqual([account])
    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]?.[0]?.webAiAccountId).toBe(
      account.id
    )
  })

  it('hydrates multiple account tabs in the synthetic workspace and reuses the active one', () => {
    const store = createTestStore()
    const account = webAiAccount({ provider: 'claude' })
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    const firstWorkspaceId = 'restored-web-ai-workspace-1'
    const secondWorkspaceId = 'restored-web-ai-workspace-2'
    const firstPageId = 'restored-page-1'
    const secondPageId = 'restored-page-2'
    store.setState({
      activeWorktreeId: accountWorkspaceId,
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })

    store.getState().hydrateBrowserSession({
      activeRepoId: null,
      activeWorktreeId: accountWorkspaceId,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      browserTabsByWorktree: {
        [accountWorkspaceId]: [
          {
            id: firstWorkspaceId,
            worktreeId: accountWorkspaceId,
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition,
            webAiAccountId: account.id,
            activePageId: firstPageId,
            pageIds: [firstPageId],
            url: 'https://claude.ai/',
            title: 'Claude',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          },
          {
            id: secondWorkspaceId,
            worktreeId: accountWorkspaceId,
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition,
            webAiAccountId: account.id,
            activePageId: secondPageId,
            pageIds: [secondPageId],
            url: 'https://claude.ai/new',
            title: 'Second conversation',
            loading: false,
            faviconUrl: null,
            canGoBack: true,
            canGoForward: false,
            loadError: null,
            createdAt: 2
          }
        ]
      },
      browserPagesByWorkspace: {
        [firstWorkspaceId]: [
          {
            id: firstPageId,
            workspaceId: firstWorkspaceId,
            worktreeId: accountWorkspaceId,
            url: 'https://claude.ai/',
            title: 'Claude',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ],
        [secondWorkspaceId]: [
          {
            id: secondPageId,
            workspaceId: secondWorkspaceId,
            worktreeId: accountWorkspaceId,
            url: 'https://claude.ai/new',
            title: 'Second conversation',
            loading: false,
            faviconUrl: null,
            canGoBack: true,
            canGoForward: false,
            loadError: null,
            createdAt: 2
          }
        ]
      },
      activeBrowserTabIdByWorktree: {
        [accountWorkspaceId]: secondWorkspaceId
      },
      activeTabTypeByWorktree: { [accountWorkspaceId]: 'browser' }
    })

    const reopened = store.getState().openWebAiAccount(account)

    expect(reopened?.id).toBe(secondWorkspaceId)
    expect(reopened?.activePageId).toBe(secondPageId)
    expect(reopened).toMatchObject({ canGoBack: false, canGoForward: false })
    expect(store.getState().browserPagesByWorkspace[firstWorkspaceId]).toHaveLength(1)
    expect(store.getState().browserPagesByWorkspace[secondWorkspaceId]).toHaveLength(1)
    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]).toHaveLength(2)
  })

  it('migrates legacy hidden account pages into visible browser tabs on hydration', () => {
    const store = createTestStore()
    const account = webAiAccount({ provider: 'claude' })
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    const workspaceId = 'legacy-web-ai-workspace'
    const firstPageId = 'legacy-page-1'
    const activePageId = 'legacy-page-2'
    store.setState({
      activeWorktreeId: accountWorkspaceId,
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })

    store.getState().hydrateBrowserSession({
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: accountWorkspaceId,
      browserTabsByWorktree: {
        [accountWorkspaceId]: [
          {
            id: workspaceId,
            worktreeId: accountWorkspaceId,
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition,
            webAiAccountId: account.id,
            activePageId,
            pageIds: [firstPageId, activePageId],
            url: 'https://claude.ai/chat/active',
            title: 'Active conversation',
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
        [workspaceId]: [
          {
            id: firstPageId,
            workspaceId,
            worktreeId: accountWorkspaceId,
            url: 'https://claude.ai/',
            title: 'Claude',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          },
          {
            id: activePageId,
            workspaceId,
            worktreeId: accountWorkspaceId,
            url: 'https://claude.ai/chat/active',
            title: 'Active conversation',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 2
          }
        ]
      },
      activeBrowserTabIdByWorktree: {
        [accountWorkspaceId]: workspaceId
      },
      activeTabTypeByWorktree: { [accountWorkspaceId]: 'browser' }
    })

    const workspaces = store.getState().browserTabsByWorktree[accountWorkspaceId] ?? []
    expect(workspaces).toHaveLength(2)
    expect(workspaces.map((workspace) => workspace.url).sort()).toEqual([
      'https://claude.ai/',
      'https://claude.ai/chat/active'
    ])
    expect(
      workspaces.every(
        (workspace) => store.getState().browserPagesByWorkspace[workspace.id]?.length === 1
      )
    ).toBe(true)
    expect(workspaces.find((workspace) => workspace.id === workspaceId)?.activePageId).toBe(
      activePageId
    )
    expect(store.getState().openWebAiAccount(account)?.id).toBe(workspaceId)
  })

  it('round-trips account identity and visible tabs through the persisted session schema', () => {
    const firstStore = createTestStore()
    const account = webAiAccount({ provider: 'claude' })
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    firstStore.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const workspace = firstStore.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }
    const secondWorkspace = firstStore.getState().openWebAiAccount(account, { openNewTab: true })
    if (!secondWorkspace) {
      throw new Error('Expected a second Web AI browser workspace')
    }
    const originalWorkspaces = firstStore.getState().browserTabsByWorktree[accountWorkspaceId] ?? []
    const browserData = buildBrowserSessionData(
      firstStore.getState().browserTabsByWorktree,
      firstStore.getState().browserPagesByWorkspace,
      firstStore.getState().activeBrowserTabIdByWorktree
    )
    const parsed = parseWorkspaceSession(
      JSON.parse(
        JSON.stringify({
          ...getDefaultWorkspaceSession(),
          activeWorktreeId: accountWorkspaceId,
          activeWorkspaceKey: `worktree:${accountWorkspaceId}`,
          activeTabTypeByWorktree: { [accountWorkspaceId]: 'browser' },
          ...browserData
        })
      )
    )
    if (!parsed.ok) {
      throw new Error('Expected the Web AI session to parse')
    }

    const restoredStore = createTestStore()
    restoredStore.setState({
      activeWorktreeId: accountWorkspaceId,
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    restoredStore.getState().hydrateBrowserSession(parsed.value)
    const reopened = restoredStore.getState().openWebAiAccount(account)

    expect(reopened?.id).toBe(secondWorkspace.id)
    expect(reopened).toMatchObject({
      webAiAccountId: account.id,
      sessionProfileId: account.profileId,
      sessionPartition: account.sessionPartition
    })
    expect(
      restoredStore.getState().browserTabsByWorktree[accountWorkspaceId]?.map((entry) => ({
        id: entry.id,
        webAiAccountId: entry.webAiAccountId,
        sessionProfileId: entry.sessionProfileId,
        sessionPartition: entry.sessionPartition
      }))
    ).toEqual(
      originalWorkspaces.map((entry) => ({
        id: entry.id,
        webAiAccountId: entry.webAiAccountId,
        sessionProfileId: entry.sessionProfileId,
        sessionPartition: entry.sessionPartition
      }))
    )
    expect(restoredStore.getState().browserTabsByWorktree[accountWorkspaceId]).toHaveLength(2)
    expect(restoredStore.getState().browserPagesByWorkspace[workspace.id]).toHaveLength(1)
    expect(restoredStore.getState().browserPagesByWorkspace[secondWorkspace.id]).toHaveLength(1)
  })
})

describe('createBrowserSlice runtime guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    createWebRuntimeSessionBrowserTabMock.mockReset()
    createWebRuntimeSessionBrowserTabMock.mockResolvedValue(true)
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
    expect(store.getState().browserSessionProfilesByHostId['runtime:env-1']).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
  })

  it('keeps browser profile lists separate per host', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-remote',
      ok: true,
      result: {
        profiles: [
          {
            id: 'remote-default',
            scope: 'default',
            partition: 'persist:orca-remote',
            label: 'Remote Default',
            source: null
          }
        ]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({ settings: settingsWithRuntime('env-1') })

    await store.getState().fetchBrowserSessionProfiles()

    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: 'local-default',
        scope: 'default',
        partition: 'persist:orca-local',
        label: 'Local Default',
        source: null
      }
    ])
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as AppState['settings'] })

    await store.getState().fetchBrowserSessionProfiles()

    expect(store.getState().browserSessionProfilesByHostId['runtime:env-1']?.[0]?.id).toBe(
      'remote-default'
    )
    expect(store.getState().browserSessionProfilesByHostId.local?.[0]?.id).toBe('local-default')
    expect(store.getState().browserSessionProfiles[0]?.id).toBe('local-default')
  })

  it('uses the target worktree host default profile when creating a browser tab', () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: null,
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            path: '/repo/wt',
            head: 'abc123',
            branch: 'feature',
            isBare: false,
            isMainWorktree: false,
            displayName: 'Workspace',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 1
          }
        ]
      },
      defaultBrowserSessionProfileId: 'local-default',
      defaultBrowserSessionProfileIdByHostId: {
        local: 'local-default',
        'runtime:env-1': 'remote-default'
      }
    })

    const tab = store.getState().createBrowserTab('wt-remote', 'https://example.com')

    expect(tab.sessionProfileId).toBe('remote-default')
  })

  it('stores a runtime-resolved browser partition without a renderer profile mirror', () => {
    const store = createTestStore()
    store.setState({ browserSessionProfiles: [] })

    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      sessionProfileId: 'profile-isolated',
      sessionPartition: 'persist:orca-browser-session-profile-isolated'
    })

    expect(tab.sessionProfileId).toBe('profile-isolated')
    expect(tab.sessionPartition).toBe('persist:orca-browser-session-profile-isolated')
    expect(store.getState().browserTabsByWorktree['wt-1']?.[0]?.sessionPartition).toBe(
      'persist:orca-browser-session-profile-isolated'
    )
  })

  it('stores a runtime-resolved partition when switching browser tab profiles', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      sessionProfileId: null,
      sessionPartition: 'persist:orca-browser',
      webAiAccountId: 'web-ai-account-1'
    })

    store
      .getState()
      .switchBrowserTabProfile(
        tab.id,
        'profile-isolated',
        'persist:orca-browser-session-profile-isolated'
      )

    expect(store.getState().browserTabsByWorktree['wt-1']?.[0]).toEqual(
      expect.objectContaining({
        sessionProfileId: 'profile-isolated',
        sessionPartition: 'persist:orca-browser-session-profile-isolated',
        webAiAccountId: null
      })
    )
  })

  it('keeps a saved Web AI tab on its account profile', () => {
    const store = createTestStore()
    const account = webAiAccount()
    const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)
    store.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: [account]
      } as AppState['settings']
    })
    const tab = store.getState().openWebAiAccount(account)
    if (!tab) {
      throw new Error('Expected a Web AI browser workspace')
    }

    store.getState().switchBrowserTabProfile(tab.id, 'another-profile', 'persist:another-profile')

    expect(store.getState().browserTabsByWorktree[accountWorkspaceId]?.[0]).toMatchObject({
      webAiAccountId: account.id,
      sessionProfileId: account.profileId,
      sessionPartition: account.sessionPartition
    })
  })

  it('creates new browser tabs through the owning runtime for desktop remote worktrees', async () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
      browserDefaultUrl: 'about:blank',
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: null,
          executionHostId: 'runtime:env-1'
        }
      ],
      worktreesByRepo: {
        'repo-1': [
          {
            id: 'wt-remote',
            repoId: 'repo-1',
            path: '/repo/wt',
            head: 'abc123',
            branch: 'feature',
            isBare: false,
            isMainWorktree: false,
            displayName: 'Workspace',
            comment: '',
            linkedIssue: null,
            linkedPR: null,
            linkedLinearIssue: null,
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 1
          }
        ]
      }
    })

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-remote',
      environmentId: 'env-1',
      url: 'about:blank',
      targetGroupId: 'group-1'
    })
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().recordFeatureInteraction).toHaveBeenCalledWith('browser-tab-created')
  })

  it('does not create a local fallback tab when remote browser creation fails', async () => {
    const store = createTestStore()
    // Why: a remote-owned workspace must stay remote-owned. If the remote host
    // cannot create the page, we must NOT silently open a local desktop tab —
    // that produces confusing split ownership (issue #5321 UX requirement).
    createWebRuntimeSessionBrowserTabMock.mockResolvedValueOnce(false)
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
    })

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(createWebRuntimeSessionBrowserTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-remote',
      environmentId: 'env-1',
      url: 'about:blank',
      targetGroupId: 'group-1'
    })
    // No local tab created, no unified tab, no feature interaction recorded.
    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
    expect(store.getState().recordFeatureInteraction).not.toHaveBeenCalledWith(
      'browser-tab-created'
    )
  })

  it('does not create a local fallback tab when remote browser creation throws', async () => {
    const store = createTestStore()
    createWebRuntimeSessionBrowserTabMock.mockRejectedValueOnce(new Error('remote down'))
    store.setState({
      activeWorktreeId: 'wt-remote',
      settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings']
    })

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(store.getState().browserTabsByWorktree['wt-remote']).toBeUndefined()
    expect(store.getState().createUnifiedTab).not.toHaveBeenCalled()
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

  it('ignores a stale remote browser detection result after switching to a local owner', async () => {
    const store = createTestStore()
    const remoteBrowsers = [
      {
        family: 'firefox',
        label: 'Remote Firefox',
        profiles: [],
        selectedProfile: 'default-release'
      }
    ]
    const localBrowsers = [
      {
        family: 'chrome',
        label: 'Local Chrome',
        profiles: [],
        selectedProfile: 'Default'
      }
    ]
    let resolveRemoteDetect: (value: unknown) => void = () => {}
    const remoteDetect = new Promise<unknown>((resolve) => {
      resolveRemoteDetect = resolve
    })
    runtimeEnvironmentCall.mockReturnValueOnce(remoteDetect)
    store.setState({ settings: settingsWithRuntime('env-1') })

    const remoteRequest = store.getState().fetchDetectedBrowsers()
    await vi.waitFor(() =>
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.profileDetectBrowsers',
        params: undefined,
        timeoutMs: 15_000
      })
    )
    mockApi.browser.sessionDetectBrowsers.mockResolvedValueOnce(localBrowsers)
    await store.getState().fetchDetectedBrowsers({ runtimeEnvironmentId: null })

    expect(store.getState().detectedBrowsers).toEqual(localBrowsers)
    expect(store.getState().detectedBrowsersHostId).toBe('local')

    resolveRemoteDetect({
      id: 'rpc-remote-detect',
      ok: true,
      result: { browsers: remoteBrowsers },
      _meta: { runtimeId: 'runtime-remote' }
    })
    await remoteRequest

    expect(store.getState().detectedBrowsers).toEqual(localBrowsers)
    expect(store.getState().detectedBrowsersLoaded).toBe(true)
    expect(store.getState().detectedBrowsersHostId).toBe('local')
  })

  it('keeps tagged Web AI detection and imports local while another runtime is active', async () => {
    const store = createTestStore()
    const owner = { runtimeEnvironmentId: null }
    store.setState({ settings: settingsWithRuntime('env-1') })
    mockApi.browser.sessionDetectBrowsers.mockResolvedValueOnce([
      {
        family: 'chrome',
        label: 'Google Chrome',
        profiles: [],
        selectedProfile: 'Default'
      }
    ])
    mockApi.browser.sessionImportCookies.mockResolvedValueOnce({
      ok: true,
      profileId: 'profile-chatgpt',
      summary: { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: ['chatgpt.com'] }
    })
    mockApi.browser.sessionImportFromBrowser.mockResolvedValueOnce({
      ok: true,
      profileId: 'profile-chatgpt',
      summary: { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: ['chatgpt.com'] }
    })
    const localProfiles = [
      {
        id: 'profile-chatgpt',
        scope: 'isolated' as const,
        partition: 'persist:profile-chatgpt',
        label: 'ChatGPT',
        source: null
      }
    ]
    mockApi.browser.sessionListProfiles
      .mockResolvedValueOnce(localProfiles)
      .mockResolvedValueOnce(localProfiles)

    await store.getState().fetchDetectedBrowsers(owner)
    await store.getState().importCookiesToProfile('profile-chatgpt', 'chatgpt', undefined, owner)
    await store
      .getState()
      .importCookiesFromBrowser('profile-chatgpt', 'chrome', 'Default', 'chatgpt', undefined, owner)

    expect(mockApi.browser.sessionDetectBrowsers).toHaveBeenCalledTimes(1)
    expect(mockApi.browser.sessionImportCookies).toHaveBeenCalledWith({
      profileId: 'profile-chatgpt',
      webAiProvider: 'chatgpt'
    })
    expect(mockApi.browser.sessionImportFromBrowser).toHaveBeenCalledWith({
      profileId: 'profile-chatgpt',
      browserFamily: 'chrome',
      browserProfile: 'Default',
      webAiProvider: 'chatgpt'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().detectedBrowsersHostId).toBe('local')
  })

  it('keeps ordinary browser-profile imports on the active remote runtime', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-import',
      ok: true,
      result: { ok: false, reason: 'canceled' },
      _meta: { runtimeId: 'runtime-remote' }
    })

    await store.getState().importCookiesFromBrowser('remote-profile', 'chrome')

    expect(mockApi.browser.sessionImportFromBrowser).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'browser.profileImportFromBrowser',
      params: {
        profileId: 'remote-profile',
        browserFamily: 'chrome',
        browserProfile: undefined,
        webAiProvider: undefined
      },
      timeoutMs: 30_000
    })
  })

  it('forwards the Web AI provider when importing a cookie file', async () => {
    const store = createTestStore()

    await store.getState().importCookiesToProfile('profile-claude', 'claude')

    expect(mockApi.browser.sessionImportCookies).toHaveBeenCalledWith({
      profileId: 'profile-claude',
      webAiProvider: 'claude'
    })
  })

  it('forwards the Web AI provider when importing from a browser profile', async () => {
    const store = createTestStore()

    await store
      .getState()
      .importCookiesFromBrowser('profile-gemini', 'chrome', 'Profile 2', 'gemini')

    expect(mockApi.browser.sessionImportFromBrowser).toHaveBeenCalledWith({
      profileId: 'profile-gemini',
      browserFamily: 'chrome',
      browserProfile: 'Profile 2',
      webAiProvider: 'gemini'
    })
  })

  it('forwards a validated Custom scope for file and browser-profile imports', async () => {
    const store = createTestStore()
    const cookieImportScope = {
      label: 'Example AI',
      domains: ['example.com'],
      sourceHostname: 'chat.example.com'
    }

    await store.getState().importCookiesToProfile('profile-custom', undefined, cookieImportScope)
    await store
      .getState()
      .importCookiesFromBrowser(
        'profile-custom',
        'chrome',
        'Profile 3',
        undefined,
        cookieImportScope
      )

    expect(mockApi.browser.sessionImportCookies).toHaveBeenCalledWith({
      profileId: 'profile-custom',
      webAiProvider: undefined,
      cookieImportScope
    })
    expect(mockApi.browser.sessionImportFromBrowser).toHaveBeenCalledWith({
      profileId: 'profile-custom',
      browserFamily: 'chrome',
      browserProfile: 'Profile 3',
      webAiProvider: undefined,
      cookieImportScope
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
