import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import { makeAnnotation } from './browser-annotation-test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'
import type { ManagedBrowserProfileOwner } from '../../../../shared/browser-profile-scope'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  createBrowserMockApi,
  createTestStore,
  settingsWithRuntime
} from './browser-slice-test-harness'
import {
  createTestStoreDrawnFromMain,
  type BrowserTestStore
} from './browser-slice-drawn-from-main.test-fixture'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function seedUnifiedBrowserTab(store: BrowserTestStore, entityId: string, label: string): void {
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

describe('createBrowserSlice annotations', () => {
  it('announces the store-selected browser page before its guest is destroyed', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const previous = store.getState().createBrowserTab('wt-1', 'https://previous.example.com')
    await main.settle()
    const closing = store.getState().createBrowserTab('wt-1', 'https://closing.example.com')
    await main.settle()
    store.getState().setActiveBrowserTab(previous.id)
    store.getState().setActiveBrowserTab(closing.id)
    mockApi.browser.notifyActiveTabChanged.mockClear()

    store.getState().closeBrowserTab(closing.id)
    await main.settle()

    expect(mockApi.browser.notifyActiveTabChanged).toHaveBeenCalledWith({
      browserPageId: previous.activePageId
    })
  })

  it('announces a tab that creation activates, but not one opened in the background', async () => {
    const { store } = await createTestStoreDrawnFromMain()
    mockApi.browser.notifyActiveTabChanged.mockClear()

    const background = store
      .getState()
      .createBrowserTab('wt-1', 'https://background.example.com', { activate: false })
    const active = store.getState().createBrowserTab('wt-1', 'https://active.example.com')

    expect(mockApi.browser.notifyActiveTabChanged).not.toHaveBeenCalledWith({
      browserPageId: background.activePageId
    })
    expect(mockApi.browser.notifyActiveTabChanged).toHaveBeenLastCalledWith({
      browserPageId: active.activePageId
    })
  })

  it('keeps a requested canonical page identity distinct from its workspace', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserPageId: 'page-canonical'
    })
    await main.settle()

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
    const { store, main } = await createTestStoreDrawnFromMain()

    store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
    expect(store.getState().recordFeatureInteraction).not.toHaveBeenCalledWith(
      'browser-tab-created'
    )

    await store.getState().openNewBrowserTabInActiveWorkspace('group-1')

    expect(store.getState().recordFeatureInteraction).toHaveBeenCalledWith('browser-tab-created')
  })

  it('opens a local sign-in tab with the imported browser profile', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()

    await expect(
      store
        .getState()
        .openBrowserProfileTabInActiveWorkspace('https://accounts.google.com/', 'profile-1')
    ).resolves.toBe(true)
    await main.settle()

    expect(store.getState().browserTabsByWorktree['wt-1']?.[0]).toMatchObject({
      url: 'https://accounts.google.com/',
      sessionProfileId: 'profile-1'
    })
  })

  it('can commit a navigation URL without hiding an active recovery error', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
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

  it('keeps certificate challenges transient across navigation, success, and close', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://localhost:3443/')
    await main.settle()
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
    await main.settle()
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()
  })

  it('creates inactive browser unified tabs without stealing the visible tab', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()

    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      activate: false
    })
    await main.settle()

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main opens the tab and its frame draws it; the window leaves it unselected.
      expect(layoutApplyTestTransport.sentOfType('openBrowserTab')).toEqual([
        expect.objectContaining({ browserTabId: tab.id, groupId: 'group-1' })
      ])
      expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([
        expect.objectContaining({ contentType: 'browser', entityId: tab.id })
      ])
      expect(store.getState().activateTab).not.toHaveBeenCalled()
    } else {
      expect(store.getState().createUnifiedTab).toHaveBeenCalledWith(
        'wt-1',
        'browser',
        expect.objectContaining({ activate: false })
      )
    }
    // A background open leaves the worktree's remembered browser tab unset.
    expect(store.getState().activeBrowserTabIdByWorktree['wt-1']).toBeNull()
    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeBrowserTabId).toBeNull()
  })

  it('creates pages cold so a deferred guest is never owed a navigation', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()

    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      activate: false
    })
    await main.settle()
    const second = store
      .getState()
      .createBrowserPage(tab.id, 'https://example.com/second', { activate: false })
    await main.settle()

    // A layout-owner build's main adds the page and its frame draws it.
    expect(layoutApplyTestTransport.sentOfType('openBrowserPage')).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN ? [expect.objectContaining({ pageId: second?.id })] : []
    )
    // Why: only a live guest reports loading; a background page has none until first shown.
    expect(store.getState().browserPagesByWorkspace[tab.id]?.map((page) => page.loading)).toEqual([
      false,
      false
    ])
    expect(tab.loading).toBe(false)
  })

  it('uses local browser profile defaults for client-local fallback pages', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    store.setState({
      settings: {
        ...settingsWithRuntime('env-1')!,
        browserDefaultProfileIdByHostId: {
          local: 'local-profile',
          'runtime:env-1': 'runtime-profile'
        }
      }
    })

    const localFallback = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserRuntimeEnvironmentId: null
    })
    await main.settle()
    const remoteTab = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserRuntimeEnvironmentId: 'env-1'
    })
    await main.settle()

    expect(localFallback.sessionProfileId).toBe('local-profile')
    expect(remoteTab.sessionProfileId).toBe('runtime-profile')
  })

  it('gives each repo its own profile under the per-repo scope and holds pages until main has it', async () => {
    const created = new Map<string, (profile: BrowserSessionProfile) => void>()
    const ensureMock = vi.fn(
      ({ owner }: { owner: ManagedBrowserProfileOwner }) =>
        new Promise<BrowserSessionProfile>((resolve) => created.set(owner.id, resolve))
    )
    Object.assign(mockApi.browser, { sessionEnsureManagedProfile: ensureMock })
    const { store, main } = await createTestStoreDrawnFromMain({
      repos: [],
      settings: {
        ...getDefaultSettings('/tmp'),
        browserProfileScope: 'repo',
        browserDefaultProfileIdByHostId: { local: 'user-default' }
      }
    })

    const first = store.getState().createBrowserTab('repo-a::/a/one', 'about:blank')
    const sibling = store.getState().createBrowserTab('repo-a::/a/two', 'about:blank')
    const other = store.getState().createBrowserTab('repo-b::/b/one', 'about:blank')
    await main.settle()

    const placeholderId = first.sessionProfileId ?? ''
    expect(sibling.sessionProfileId).toBe(placeholderId)
    expect(other.sessionProfileId).not.toBe(placeholderId)
    expect(placeholderId).not.toBe('user-default')
    expect(ensureMock.mock.calls.map(([args]) => args.owner)).toEqual([
      { kind: 'repo', id: 'repo-a' },
      { kind: 'repo', id: 'repo-b' }
    ])
    expect(store.getState().managedBrowserProfileStatusById[placeholderId]).toBe('pending')
    // A placeholder that outlives this run must load nowhere, never on the shared Default jar.
    expect(first.sessionPartition).toBe(`persist:orca-browser-unminted-${placeholderId}`)
    store.getState().closeBrowserTab(sibling.id)
    await main.settle()

    const profile: BrowserSessionProfile = {
      id: 'minted-by-main',
      scope: 'isolated',
      partition: 'persist:orca-browser-session-minted-by-main',
      label: 'Repo: repo-a',
      source: null,
      owner: { kind: 'repo', id: 'repo-a' }
    }
    created.get('repo-a')?.(profile)
    await vi.waitFor(() =>
      expect(store.getState().managedBrowserProfileStatusById[placeholderId]).toBeUndefined()
    )
    // A tab closed while it waited reopens on the profile main made, not the placeholder.
    expect(store.getState().reopenClosedBrowserTab('repo-a::/a/two')).not.toBeNull()
    await main.settle()
    const repoATabs = ['repo-a::/a/one', 'repo-a::/a/two'].flatMap(
      (worktreeId) => store.getState().browserTabsByWorktree[worktreeId] ?? []
    )
    expect(repoATabs.map((tab) => tab.sessionPartition ?? null)).toEqual([null, null])
    expect(repoATabs.map((tab) => tab.sessionProfileId)).toEqual([
      'minted-by-main',
      'minted-by-main'
    ])
    expect(store.getState().browserSessionProfilesByHostId.local).toEqual([profile])

    const later = store.getState().createBrowserTab('repo-a::/a/three', 'about:blank')
    expect(later.sessionProfileId).toBe('minted-by-main')
    expect(store.getState().managedBrowserProfileStatusById['minted-by-main']).toBeUndefined()
  })

  it('preserves browser map references when a page-state update is unchanged', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    await main.settle()
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

  it('persists a captured favicon with history and refreshes it with the page state', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    await main.settle()
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

  it('clears a stale history favicon when a page reports none, and keeps it when none is reported', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    await main.settle()
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

  it('puts a removed history page back as it was on Undo, unless a revisit already re-created it', () => {
    const store = createTestStore()
    store.getState().addBrowserHistoryEntry('https://example.com', 'Example')
    store.getState().addBrowserHistoryEntry('https://example.com', 'Example')
    const [visited] = store.getState().browserUrlHistory

    const removed = store.getState().removeBrowserHistoryEntry(visited!.normalizedUrl)
    expect(removed).toBe(visited)
    expect(store.getState().browserUrlHistory).toEqual([])
    store
      .getState()
      .restoreBrowserHistory({ browserUrlHistory: [removed!], workspaceDocHistory: [] })
    expect(store.getState().browserUrlHistory).toEqual([visited])

    store.getState().removeBrowserHistoryEntry(visited!.normalizedUrl)
    store.getState().addBrowserHistoryEntry('https://example.com', 'Example')
    const revisited = store.getState().browserUrlHistory
    store
      .getState()
      .restoreBrowserHistory({ browserUrlHistory: [removed!], workspaceDocHistory: [] })
    expect(store.getState().browserUrlHistory).toBe(revisited)
  })

  it('clears pages and documents visited since a time, and Undo puts back exactly those', () => {
    vi.useFakeTimers()
    try {
      const store = createTestStore()
      const doc = { kind: 'workspace-doc' as const, worktreeId: 'wt-1', filePath: '/repo/a.html' }
      vi.setSystemTime(1_000)
      store.getState().addBrowserHistoryEntry('https://old.example', 'Old')
      vi.setSystemTime(5_000)
      store.getState().addBrowserHistoryEntry('https://new.example', 'New')
      store.getState().recordWorkspaceDocVisit(doc, 'Doc')

      const removed = store.getState().clearBrowserHistory(5_000)
      expect(store.getState().browserUrlHistory.map((e) => e.title)).toEqual(['Old'])
      expect(store.getState().workspaceDocHistory).toEqual([])

      store.getState().restoreBrowserHistory(removed)
      expect(
        store
          .getState()
          .browserUrlHistory.map((e) => e.title)
          .sort()
      ).toEqual(['New', 'Old'])
      expect(store.getState().workspaceDocHistory.map((e) => e.title)).toEqual(['Doc'])

      store.getState().clearBrowserHistory()
      expect(store.getState().browserUrlHistory).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('repairs a stale active browser unified-tab label on an otherwise unchanged title update', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    await main.settle()
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

  it('repairs stale active browser workspace metadata on an otherwise unchanged page update', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    await main.settle()
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
      loading: false,
      canGoBack: false,
      canGoForward: false
    })
    expect(store.getState().browserPagesByWorkspace).toBe(browserPagesByWorkspace)
  })

  it('updates the active browser unified-tab label without a second tab-label write', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    await main.settle()
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    seedUnifiedBrowserTab(store, tab.id, 'Example')

    store.getState().updateBrowserPageState(pageId, { title: 'Next', loading: false })

    expect(store.getState().unifiedTabsByWorktree['wt-1']?.[0]?.label).toBe('Next')
    expect(store.getState().setTabLabel).not.toHaveBeenCalled()
  })

  it('updates inactive browser pages without relabeling or rebuilding the workspace map', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com', {
      title: 'Example'
    })
    await main.settle()
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
    await main.settle()
    if (!inactivePage) {
      throw new Error('Expected inactive browser page')
    }
    expect(layoutApplyTestTransport.sentOfType('openBrowserPage')).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? [expect.objectContaining({ browserTabId: tab.id, pageId: inactivePage.id })]
        : []
    )
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

  it('refuses browser annotations past the per-page cap instead of dropping the oldest', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }

    for (let index = 0; index < GRAB_BUDGET.annotationsMaxPerPage + 3; index++) {
      store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, `annotation-${index}`))
    }

    const annotations = store.getState().browserAnnotationsByPageId[pageId] ?? []
    expect(annotations).toHaveLength(GRAB_BUDGET.annotationsMaxPerPage)
    expect(annotations[0]?.id).toBe('annotation-0')
    expect(annotations.at(-1)?.id).toBe(`annotation-${GRAB_BUDGET.annotationsMaxPerPage - 1}`)
  })

  it('sanitizes persistent annotation payloads at the store boundary', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
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

  it('updates an existing annotation comment and intent', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
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

  it('sanitizes an oversized comment when updating an annotation', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
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

  it('is a no-op when updating an annotation id that does not exist', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
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
  it('tracks new floating browser tabs without changing the main browser surface', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    store.setState({ activeWorktreeId: 'wt-1', activeTabType: 'terminal' } as Partial<AppState>)
    const mainTab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
    const activeTabTypeBeforeFloating = store.getState().activeTabType

    const tab = store.getState().createBrowserTab(FLOATING_TERMINAL_WORKTREE_ID, 'about:blank', {
      focusAddressBar: true
    })
    await main.settle()

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
  it('reopens duplicate-URL browser pages on the originally active page', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com/dashboard', {
      title: 'First copy'
    })
    await main.settle()
    const secondPage = store.getState().createBrowserPage(tab.id, 'https://example.com/dashboard', {
      title: 'Second copy'
    })
    await main.settle()
    if (!secondPage) {
      throw new Error('Expected a second browser page')
    }

    store.getState().closeBrowserTab(tab.id)
    await main.settle()
    const restored = store.getState().reopenClosedBrowserTab('wt-1')
    // Main draws the tab, then the window sends its second page.
    await main.settle()
    await main.settle()
    if (!restored) {
      throw new Error('Expected a reopened browser workspace')
    }
    const restoredPages = store.getState().browserPagesByWorkspace[restored.id] ?? []
    // The returned record is as proposed; the drawn one carries the reselected page.
    const activePageId = store
      .getState()
      .browserTabsByWorktree['wt-1']?.find((entry) => entry.id === restored.id)?.activePageId
    const activePage = restoredPages.find((page) => page.id === activePageId)

    expect(restoredPages.map((page) => page.url)).toEqual([
      'https://example.com/dashboard',
      'https://example.com/dashboard'
    ])
    expect(activePage?.title).toBe('Second copy')
    // A layout-owner build's main closed the tab, then reopened it with both pages.
    expect(layoutApplyTestTransport.sent.map((command) => command.type)).toEqual(
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? ['openBrowserTab', 'openBrowserPage', 'closeTabs', 'openBrowserTab', 'openBrowserPage']
        : []
    )
  })
})
