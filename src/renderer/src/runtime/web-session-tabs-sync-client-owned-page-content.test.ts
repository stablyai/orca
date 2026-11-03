import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import type { RuntimeBrowserClientPlacement } from '../../../shared/runtime-browser-placement'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import './web-session-tabs-sync/tracking-mappings'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
import { resetBrowserClientHostIdForTests } from './browser-client-host-identity'
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

const REMOTE_PAGE = 'host-browser-page'
const HOST_TAB = 'host-browser-unified'
const LOCAL_WORKSPACE = 'local-browser-workspace'
const LOCAL_PAGE = 'local-browser-page'
const LOCAL_UNIFIED_TAB = 'local-browser-unified'
const GROUP = 'host-group-1'

const THIS_CLIENT = 'browser-host-a'
const OTHER_CLIENT = 'browser-host-b'

const CLIENT_PLACEMENT: RuntimeBrowserClientPlacement = {
  kind: 'client',
  browserHostClientId: THIS_CLIENT,
  browserHostGeneration: 1,
  pageHostGeneration: 1
}

/** Stands this client up as the given browser host, or — for null — as a renderer main stamped none. */
function hostingClient(browserHostClientId: string | null): void {
  vi.stubGlobal('api', { browser: { readClientHostId: () => browserHostClientId } })
  resetBrowserClientHostIdForTests()
}

/** The web client: an api with a browser namespace that carries no such accessor at all. */
function hostingNothingOnWeb(): void {
  vi.stubGlobal('api', { browser: {} })
  resetBrowserClientHostIdForTests()
}

const GUEST_URL = 'https://www.google.com/maps/@37.7,-122.4,12z'
const GUEST_TITLE = 'Google Maps'
const HOST_STALE_URL = 'https://maps.google.com/'
const HOST_FALLBACK_TITLE = 'Browser'
const MOVED_GUEST_URL = 'https://www.google.com/maps/place/Ferry+Building'
const MOVED_GUEST_TITLE = 'Ferry Building'

function localPage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id: LOCAL_PAGE,
    workspaceId: LOCAL_WORKSPACE,
    worktreeId: WT,
    url: GUEST_URL,
    title: GUEST_TITLE,
    loading: false,
    faviconUrl: null,
    canGoBack: true,
    canGoForward: true,
    loadError: null,
    createdAt: NOW - 10,
    browserRuntimeEnvironmentId: ENV,
    viewportPresetId: null,
    ...overrides
  }
}

function localWorkspace(page: BrowserPage): BrowserWorkspace {
  return {
    id: LOCAL_WORKSPACE,
    worktreeId: WT,
    activePageId: page.id,
    pageIds: [page.id],
    url: page.url,
    title: page.title,
    loading: page.loading,
    faviconUrl: page.faviconUrl,
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    loadError: page.loadError,
    createdAt: page.createdAt
  }
}

function localUnifiedTab(page: BrowserPage): Tab {
  return {
    id: LOCAL_UNIFIED_TAB,
    entityId: LOCAL_WORKSPACE,
    groupId: GROUP,
    worktreeId: WT,
    contentType: 'browser',
    label: page.title,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: page.createdAt,
    isPreview: false,
    isPinned: false
  }
}

function stateWithLocalRow(page: BrowserPage = localPage()): WebSessionTabsSyncState {
  const workspace = localWorkspace(page)
  const unifiedTab = localUnifiedTab(page)
  return makeState({
    browserTabsByWorktree: { [WT]: [workspace] },
    browserPagesByWorkspace: { [workspace.id]: [page] },
    remoteBrowserPageHandlesByPageId: {
      [page.id]: { environmentId: ENV, remotePageId: REMOTE_PAGE, placement: CLIENT_PLACEMENT }
    },
    unifiedTabsByWorktree: { [WT]: [unifiedTab] },
    groupsByWorktree: {
      [WT]: [
        {
          id: GROUP,
          worktreeId: WT,
          activeTabId: unifiedTab.id,
          tabOrder: [unifiedTab.id],
          recentTabIds: [unifiedTab.id]
        }
      ]
    }
  })
}

function staleHostSnapshot(
  overrides: Partial<RuntimeMobileSessionTabsResult['tabs'][number] & { placement: unknown }> = {},
  snapshotOverrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return makeSnapshot(
    [
      {
        type: 'browser',
        id: HOST_TAB,
        title: HOST_FALLBACK_TITLE,
        browserWorkspaceId: REMOTE_PAGE,
        browserPageId: REMOTE_PAGE,
        url: HOST_STALE_URL,
        loading: true,
        canGoBack: false,
        canGoForward: false,
        placement: CLIENT_PLACEMENT,
        isActive: true,
        ...overrides
      } as RuntimeMobileSessionTabsResult['tabs'][number]
    ],
    { activeTabId: HOST_TAB, activeTabType: 'browser', ...snapshotOverrides }
  )
}

function movedHostSnapshot(): RuntimeMobileSessionTabsResult {
  return staleHostSnapshot(
    { title: GUEST_TITLE, url: GUEST_URL, loading: false, canGoBack: true, canGoForward: true },
    { snapshotVersion: 2 }
  )
}

function mergePatch(
  state: WebSessionTabsSyncState,
  patch: Partial<WebSessionTabsSyncState>
): WebSessionTabsSyncState {
  return { ...state, ...patch }
}

function applyStaleSnapshot(
  state: WebSessionTabsSyncState,
  snapshot = staleHostSnapshot()
): Partial<WebSessionTabsSyncState> {
  return applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW) as Partial<WebSessionTabsSyncState>
}

function guestNavigated(
  state: WebSessionTabsSyncState,
  url: string,
  title: string
): WebSessionTabsSyncState {
  const page = state.browserPagesByWorkspace[LOCAL_WORKSPACE]?.[0]
  if (!page) {
    throw new Error('guestNavigated needs a local row')
  }
  return {
    ...state,
    browserPagesByWorkspace: { [LOCAL_WORKSPACE]: [{ ...page, url, title }] }
  }
}

describe('browser rows this client hosts own their page content', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    hostingClient(THIS_CLIENT)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetBrowserClientHostIdForTests()
  })

  // Mirrors also have local rows after one snapshot; require a second snapshot to expose predicates that freeze every mirror.
  it.each([
    ['a second desktop client', () => hostingClient(OTHER_CLIENT)],
    ['the web client, whose api cannot answer', hostingNothingOnWeb],
    ['a renderer that was stamped no host id', () => hostingClient(null)]
  ])('keeps tracking the host on %s', (_label, standUpClient) => {
    standUpClient()
    const first = makeState()
    const afterFirst = mergePatch(first, applyStaleSnapshot(first))
    const afterSecond = mergePatch(afterFirst, applyStaleSnapshot(afterFirst, movedHostSnapshot()))

    expect(afterSecond.browserPagesByWorkspace[REMOTE_PAGE]?.[0]).toMatchObject({
      title: GUEST_TITLE,
      url: GUEST_URL,
      loading: false,
      canGoBack: true,
      canGoForward: true
    })
  })

  // Same placement/two snapshots with this client owning the guest: host content must lose.
  it('keeps the guest truth across repeated snapshots on the client hosting the page', () => {
    const first = stateWithLocalRow()
    const afterFirst = mergePatch(first, applyStaleSnapshot(first))
    const navigated = guestNavigated(afterFirst, MOVED_GUEST_URL, MOVED_GUEST_TITLE)
    const afterSecond = mergePatch(
      navigated,
      applyStaleSnapshot(navigated, staleHostSnapshot({}, { snapshotVersion: 2 }))
    )

    expect(afterSecond.browserPagesByWorkspace[LOCAL_WORKSPACE]?.[0]).toMatchObject({
      title: MOVED_GUEST_TITLE,
      url: MOVED_GUEST_URL
    })
  })
})
