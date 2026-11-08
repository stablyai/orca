import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../types'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../../shared/browser-grab-types'
import { makeAnnotation } from './annotations/browser-annotation-test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../../shared/constants'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { BrowserSessionProfile } from '../../../../../shared/browser-workspace-types'
import type { ManagedBrowserProfileOwner } from '../../../../../shared/browser-profile-scope'
import { layoutApplyTestTransport } from '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { createBrowserMockApi, createTestStore } from './browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from './browser-slice-drawn-from-main.test-fixture'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

describe('createBrowserSlice annotations', () => {
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
    expect(stored?.payload.screenshot).toBeNull()
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
