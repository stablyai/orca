import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { Tab } from '../../../shared/tab-types'
import type { RuntimeBrowserClientPlacement } from '../../../shared/runtime-browser-placement'
import {
  applyWebSessionTabsSnapshot,
  resolveHostSessionTabIdForWebSessionTab,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
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

/** Where the local guest actually is after the user navigated it. */
const GUEST_URL = 'https://www.google.com/maps/@37.7,-122.4,12z'
const GUEST_TITLE = 'Google Maps'
/** What the host still believes: the create-time url, and the registry's untouched title default. */
const HOST_STALE_URL = 'https://maps.google.com/'
const HOST_FALLBACK_TITLE = 'Browser'
/** Where the guest goes next, while the host keeps republishing the same stale row. */
const MOVED_GUEST_URL = 'https://www.google.com/maps/place/Ferry+Building'
const MOVED_GUEST_TITLE = 'Ferry Building'
/** Submitted against a page the host had not minted yet, so the row moved before the guest did. */
const DEFERRED_URL = 'https://example.internal/deferred'

/** The local row as the guest webview left it: navigated, settled, one entry of history behind it. */
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

/** The snapshot the host republishes on tab focus / workspace switch, frozen at create time. */
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

/** The same page one snapshot later, with the host caught up to where the guest actually is. */
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

/**
 * An omitted patch key means unchanged, and an owned row that the snapshot leaves alone omits it
 * entirely — so read through to the seeded state rather than asserting on the diff.
 */
function syncedPage(
  patch: Partial<WebSessionTabsSyncState>,
  state: WebSessionTabsSyncState,
  workspaceId = LOCAL_WORKSPACE
): BrowserPage | undefined {
  return (patch.browserPagesByWorkspace ?? state.browserPagesByWorkspace)[workspaceId]?.[0]
}

/** What the pane writes to the local row when the guest finishes a navigation. */
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

  // The reported bug: host title is the registry's 'Browser' default and its url never moved off
  // create time, so the staged-title hold's url-equality arm fails the moment the guest navigates.
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

  it('keeps the local loading flag instead of the host create-time value', () => {
    const state = stateWithLocalRow()

    expect(syncedPage(applyStaleSnapshot(state), state)?.loading).toBe(false)
  })

  it('keeps local canGoBack instead of the host default', () => {
    const state = stateWithLocalRow()

    expect(syncedPage(applyStaleSnapshot(state), state)?.canGoBack).toBe(true)
  })

  it('keeps local canGoForward instead of the host default', () => {
    const state = stateWithLocalRow()

    expect(syncedPage(applyStaleSnapshot(state), state)?.canGoForward).toBe(true)
  })

  // Why a real title is covered separately: a host that has learned the title publishes a
  // non-fallback string, which the staged-title hold would have accepted. Ownership, not staleness.
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

  // Why this and not just the value: a repeated stale snapshot that rebuilds an equal page still
  // remounts the pane if it lands in the store, so ownership has to make the patch a no-op.
  it('leaves the page list untouched when a stale host snapshot repeats', () => {
    const patch = applyStaleSnapshot(stateWithLocalRow())

    expect(patch.browserPagesByWorkspace?.[LOCAL_WORKSPACE]).toBeUndefined()
  })

  // Why two snapshots and not one: every client holds a local row from its first snapshot onward,
  // so a predicate that asks only whether a row exists cannot tell a mirror from a host until the
  // second one arrives — and by then the mirror it froze is a permanent one.
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

  // The other side of that boundary: the same placement, the same two snapshots, and the only
  // difference is that the guest is this client's — so here the host's echo must lose.
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

  // Why a mirror still needs the host's own title hold: taking host content is not the same as
  // taking whatever string the projection emitted, and the fallback is one of its outputs.
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

  // Why a placement that names nobody has to be handled: session-tab snapshots are not validated
  // against the placement schema on the way in, so a host on another version can publish one — and
  // over the wire an absent id arrives as JSON null, which is also what this client reports when it
  // hosts nothing. Two absent identities are not a match.
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

  // Why an explicit server placement and not just an absent one: mixed versions really do publish
  // it, and an absence-only test cannot tell a client check apart from a placement check.
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

  // Why the very first placement-bearing snapshot: between the host minting the placement and this
  // client's guest attaching to it, the host publishes its create-time row and the guest cannot yet
  // answer. Ownership that waited for the attachment would spend that whole gap taking the host's
  // 'Browser', which is the flicker. The row here has already moved off the create url — a url the
  // user submitted while the page was still staged — so the staged-title hold cannot cover it.
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

  // Why a mapping and not a field: an owned row emits no page patch at all, so every value
  // assertion here reads through to the seeded state and would pass just as well if the row had
  // been dropped from the mirror entirely. The host tab id is only recorded for rows that survive.
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
