import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import type { RuntimeBrowserClientPlacement } from '../../../shared/runtime-browser-placement'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resolveHostSessionTabIdForWebSessionTab } from './web-session-tabs-sync/tracking-mappings'
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
const DEFERRED_URL = 'https://example.internal/deferred'

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

// Omitted patch fields mean unchanged; assert effective seeded state, not the diff.
function syncedPage(
  patch: Partial<WebSessionTabsSyncState>,
  state: WebSessionTabsSyncState,
  workspaceId = LOCAL_WORKSPACE
): BrowserPage | undefined {
  return (patch.browserPagesByWorkspace ?? state.browserPagesByWorkspace)[workspaceId]?.[0]
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

  // Stale host URL/default title defeats staged-title URL matching once the guest navigates.
  it('keeps the local title when a stale host snapshot republishes the Browser fallback', () => {
    const state = stateWithLocalRow()

    expect(syncedPage(applyStaleSnapshot(state), state)?.title).toBe(GUEST_TITLE)
  })

  it('keeps the local title on the workspace and the unified tab label', () => {
    const state = stateWithLocalRow()
    const patch = applyStaleSnapshot(state)

    expect((patch.browserTabsByWorktree ?? state.browserTabsByWorktree)[WT]?.[0]?.title).toBe(
      GUEST_TITLE
    )
    expect(
      (patch.unifiedTabsByWorktree ?? state.unifiedTabsByWorktree)[WT]?.find(
        (tab) => tab.contentType === 'browser'
      )?.label
    ).toBe(GUEST_TITLE)
  })

  it('keeps the local url instead of rewinding to the host create-time url', () => {
    const state = stateWithLocalRow()

    expect(syncedPage(applyStaleSnapshot(state), state)?.url).toBe(GUEST_URL)
  })

  // A real host title passes the staged-title hold; distinguish ownership from staleness.
  it('keeps the local title even when the host publishes a real but older title', () => {
    const state = stateWithLocalRow()
    const patch = applyStaleSnapshot(
      state,
      staleHostSnapshot({ title: 'Google Maps — Directions', url: GUEST_URL })
    )

    expect(syncedPage(patch, state)?.title).toBe(GUEST_TITLE)
  })

  it('takes host content for a client-placed page this client holds no row for', () => {
    const state = makeState()
    const patch = applyStaleSnapshot(state)

    expect(syncedPage(patch, state, REMOTE_PAGE)).toMatchObject({
      title: HOST_FALLBACK_TITLE,
      url: HOST_STALE_URL,
      loading: true,
      canGoBack: false,
      canGoForward: false
    })
  })

  it('takes host content for a streamed page even when a local row exists', () => {
    const state = stateWithLocalRow()
    const patch = applyStaleSnapshot(
      state,
      staleHostSnapshot({ placement: undefined, title: 'Example Domain' })
    )

    expect(syncedPage(patch, state)).toMatchObject({
      title: 'Example Domain',
      url: HOST_STALE_URL,
      loading: true,
      canGoBack: false,
      canGoForward: false
    })
  })

  // Equal-valued page rebuilds still remount panes; require no patch on repeated stale snapshots.
  it('leaves the page list untouched when a stale host snapshot repeats', () => {
    const patch = applyStaleSnapshot(stateWithLocalRow())

    expect(patch.browserPagesByWorkspace?.[LOCAL_WORKSPACE]).toBeUndefined()
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

  // Mirrors still need staged-title hold against host fallback titles.
  it('holds a mirrored title rather than showing the host fallback at the same url', () => {
    hostingClient(OTHER_CLIENT)
    const first = makeState()
    const afterFirst = mergePatch(first, applyStaleSnapshot(first, movedHostSnapshot()))
    const afterSecond = mergePatch(
      afterFirst,
      applyStaleSnapshot(afterFirst, staleHostSnapshot({ url: GUEST_URL }, { snapshotVersion: 3 }))
    )

    expect(afterSecond.browserPagesByWorkspace[REMOTE_PAGE]?.[0]?.title).toBe(GUEST_TITLE)
  })

  // Mixed-version snapshots bypass placement validation; absent IDs serialize as null like unhosted clients. Two absent identities do not prove ownership.
  it.each([
    ['a null host id', null],
    ['no host id at all', undefined]
  ])('takes host content for a client placement carrying %s', (_label, browserHostClientId) => {
    hostingClient(null)
    const state = stateWithLocalRow()
    const patch = applyStaleSnapshot(
      state,
      staleHostSnapshot({
        placement: {
          kind: 'client',
          browserHostClientId
        } as unknown as RuntimeBrowserClientPlacement
      })
    )

    expect(syncedPage(patch, state)).toMatchObject({
      title: HOST_FALLBACK_TITLE,
      url: HOST_STALE_URL
    })
  })

  // Mixed versions publish explicit server placement; absence-only tests miss wrong placement checks.
  it('takes host content for an explicitly server-placed page with a local row', () => {
    const state = stateWithLocalRow()
    const patch = applyStaleSnapshot(state, staleHostSnapshot({ placement: { kind: 'server' } }))

    expect(syncedPage(patch, state)).toMatchObject({
      title: HOST_FALLBACK_TITLE,
      url: HOST_STALE_URL,
      loading: true,
      canGoBack: false,
      canGoForward: false
    })
  })

  // Placement proves ownership before guest attachment. A staged navigation already changed URL, so title-hold cannot prevent first-snapshot Browser flicker.
  it('owns the row from the snapshot that adopts it, before any guest has attached', () => {
    const staged = localPage({ url: DEFERRED_URL, title: DEFERRED_URL })
    const state = makeState({
      browserTabsByWorktree: { [WT]: [localWorkspace(staged)] },
      browserPagesByWorkspace: { [LOCAL_WORKSPACE]: [staged] },
      remoteBrowserPageHandlesByPageId: {
        [staged.id]: { environmentId: ENV, remotePageId: REMOTE_PAGE, staged: true }
      },
      unifiedTabsByWorktree: { [WT]: [localUnifiedTab(staged)] }
    })

    expect(syncedPage(applyStaleSnapshot(state), state)).toMatchObject({
      url: DEFERRED_URL,
      title: DEFERRED_URL
    })
  })

  // Owned rows emit no page patch; value checks alone pass if dropped entirely. Host-tab mapping proves survival.
  it('still mirrors the row it declines to overwrite', () => {
    const state = stateWithLocalRow()
    applyStaleSnapshot(state)

    expect(
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId: ENV,
        worktreeId: WT,
        tabId: LOCAL_UNIFIED_TAB
      })
    ).toBe(HOST_TAB)
  })

  // The staged-title hold still owns the pre-adoption window and every non-client placement.
  it('still holds the local title for a streamed page parked at the same url', () => {
    const state = stateWithLocalRow()
    const patch = applyStaleSnapshot(
      state,
      staleHostSnapshot({ placement: undefined, title: HOST_FALLBACK_TITLE, url: GUEST_URL })
    )

    expect(syncedPage(patch, state)?.title).toBe(GUEST_TITLE)
  })
})
