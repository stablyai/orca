import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type {
  BrowserCertificateFailure,
  BrowserLoadError
} from '../../../shared/browser-workspace-types'
import type { RuntimeBrowserPlacement } from '../../../shared/runtime-browser-placement'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  applyFreshWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'

const ENVIRONMENT_ID = 'web-env-1'
const NOW = 1_700_000_000_000
const WORKTREE_A = 'repo::/worktree-a'
const WORKTREE_B = 'repo::/worktree-b'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_TAB_ID = 'host-tab-1'
const MIRRORED_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)

const SERVER_PLACEMENT: RuntimeBrowserPlacement = { kind: 'server' }

const CLIENT_PLACEMENT: RuntimeBrowserPlacement = {
  kind: 'client',
  browserHostClientId: 'browser-host-a',
  browserHostGeneration: 3,
  pageHostGeneration: 9
}

const LOAD_ERROR: BrowserLoadError = {
  code: -202,
  description: 'ERR_CERT_AUTHORITY_INVALID',
  validatedUrl: 'https://localhost:3443/'
}

const CERTIFICATE_FAILURE: BrowserCertificateFailure = {
  challengeId: 'challenge-1',
  browserPageId: 'host-browser-page-1',
  errorCode: -202,
  error: 'ERR_CERT_AUTHORITY_INVALID',
  origin: 'https://localhost:3443',
  displayHost: 'localhost:3443',
  canProceed: true,
  observedAt: 123
}

function makeState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: null,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

function makeSnapshot(
  worktree: string,
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  activeTabType: RuntimeMobileSessionTabsResult['activeTabType'] = 'terminal'
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: `group:${worktree}`,
    activeTabId: tabs.find((tab) => tab.isActive)?.id ?? null,
    activeTabType,
    tabs
  }
}

function makeTerminalSnapshot(
  options: {
    worktree?: string
    title?: string
    terminal?: string | null
  } = {}
): RuntimeMobileSessionTabsResult {
  const worktree = options.worktree ?? WORKTREE_A
  const terminal = options.terminal === undefined ? 'terminal-1' : options.terminal
  return makeSnapshot(worktree, [
    {
      type: 'terminal',
      id: `${HOST_TAB_ID}::${LEAF_ID}`,
      parentTabId: HOST_TAB_ID,
      leafId: LEAF_ID,
      title: options.title ?? 'host shell',
      isActive: true,
      ...(terminal === null
        ? { status: 'pending-handle' as const, terminal: null }
        : { status: 'ready' as const, terminal })
    }
  ])
}

function makeBrowserSnapshot(
  options: {
    worktree?: string
    pageId?: string
    tabId?: string
    workspaceId?: string
    title?: string
    url?: string
    loading?: boolean
    certificateFailure?: BrowserCertificateFailure | null
    placement?: RuntimeBrowserPlacement
  } = {}
): RuntimeMobileSessionTabsResult {
  const worktree = options.worktree ?? WORKTREE_A
  const pageId = options.pageId ?? 'host-browser-page-1'
  const certificateFailure =
    options.certificateFailure === undefined
      ? { ...CERTIFICATE_FAILURE, browserPageId: pageId }
      : options.certificateFailure
        ? { ...options.certificateFailure }
        : null
  return makeSnapshot(
    worktree,
    [
      {
        type: 'browser',
        id: options.tabId ?? 'host-browser-tab',
        browserWorkspaceId: options.workspaceId ?? 'host-browser-workspace',
        browserPageId: pageId,
        title: options.title ?? 'Example Domain',
        url: options.url ?? 'https://example.com/',
        loading: options.loading ?? false,
        canGoBack: false,
        canGoForward: false,
        certificateFailure,
        ...(options.placement ? { placement: options.placement } : {}),
        isActive: true
      }
    ],
    'browser'
  )
}

// Stands in for the local guest webview recording a load failure straight into the store.
function withLocalLoadFailure(state: WebSessionTabsSyncState): WebSessionTabsSyncState {
  const pages = state.browserPagesByWorkspace['host-browser-workspace'] ?? []
  return {
    ...state,
    browserPagesByWorkspace: {
      ...state.browserPagesByWorkspace,
      'host-browser-workspace': pages.map((page) => ({ ...page, loadError: LOAD_ERROR }))
    }
  }
}

function applySnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  now = NOW
): WebSessionTabsSyncState {
  const patch = applyWebSessionTabsSnapshot(state, snapshot, ENVIRONMENT_ID, now)
  return patch === state ? state : { ...state, ...patch }
}

describe('remote mirror resource identity', () => {
  beforeEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
  })

  it('keeps PTY arrays and layouts stable on an exact terminal replay', () => {
    const state = applySnapshot(makeState(), makeTerminalSnapshot())
    const ptyIds = state.ptyIdsByTabId
    const layouts = state.terminalLayoutsByTabId

    const replayed = applyWebSessionTabsSnapshot(
      state,
      makeTerminalSnapshot(),
      ENVIRONMENT_ID,
      NOW + 1
    )

    expect(replayed).toBe(state)
    expect(state.ptyIdsByTabId).toBe(ptyIds)
    expect(state.terminalLayoutsByTabId).toBe(layouts)
  })

  it('updates terminal metadata without replacing PTY arrays or layouts', () => {
    const state = applySnapshot(makeState(), makeTerminalSnapshot())
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeTerminalSnapshot({ title: 'renamed shell' }),
      ENVIRONMENT_ID,
      NOW + 1
    )
    const next = { ...state, ...patch }

    expect(next.tabsByWorktree[WORKTREE_A]?.[0]?.title).toBe('renamed shell')
    expect(next.ptyIdsByTabId).toBe(state.ptyIdsByTabId)
    expect(next.terminalLayoutsByTabId).toBe(state.terminalLayoutsByTabId)
  })

  it('clears unread state on replay without replacing PTY arrays or layouts', () => {
    const hydrated = applySnapshot(makeState(), makeTerminalSnapshot())
    const state = {
      ...hydrated,
      unreadTerminalTabs: { [MIRRORED_TAB_ID]: true as const }
    }
    const next = applySnapshot(state, makeTerminalSnapshot(), NOW + 1)

    expect(next.unreadTerminalTabs).not.toHaveProperty(MIRRORED_TAB_ID)
    expect(next.ptyIdsByTabId).toBe(state.ptyIdsByTabId)
    expect(next.terminalLayoutsByTabId).toBe(state.terminalLayoutsByTabId)
  })

  it('replaces PTY arrays and layouts when the host rotates the handle', () => {
    const state = applySnapshot(makeState(), makeTerminalSnapshot())
    const next = applySnapshot(state, makeTerminalSnapshot({ terminal: 'terminal-2' }), NOW + 1)

    expect(next.ptyIdsByTabId).not.toBe(state.ptyIdsByTabId)
    expect(next.terminalLayoutsByTabId).not.toBe(state.terminalLayoutsByTabId)
    expect(next.ptyIdsByTabId[MIRRORED_TAB_ID]).toEqual(['remote:web-env-1@@terminal-2'])
    expect(next.terminalLayoutsByTabId[MIRRORED_TAB_ID]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: 'remote:web-env-1@@terminal-2'
    })
  })

  it('retains the PTY key when a ready terminal becomes pending', () => {
    const state = applySnapshot(makeState(), makeTerminalSnapshot())
    const next = applySnapshot(state, makeTerminalSnapshot({ terminal: null }), NOW + 1)

    expect(next.ptyIdsByTabId).toBe(state.ptyIdsByTabId)
    expect(next.ptyIdsByTabId[MIRRORED_TAB_ID]).toEqual(['remote:web-env-1@@terminal-1'])
    expect(next.terminalLayoutsByTabId[MIRRORED_TAB_ID]).toBe(
      state.terminalLayoutsByTabId[MIRRORED_TAB_ID]
    )
    expect(next.terminalLayoutsByTabId[MIRRORED_TAB_ID]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: 'remote:web-env-1@@terminal-1'
    })
  })

  it('cleans up terminal resources and unread state when the host omits the tab', () => {
    const hydrated = applySnapshot(makeState(), makeTerminalSnapshot())
    const state = {
      ...hydrated,
      unreadTerminalTabs: { [MIRRORED_TAB_ID]: true as const }
    }
    const next = applySnapshot(state, makeSnapshot(WORKTREE_A, [], null), NOW + 1)

    expect(next.ptyIdsByTabId).not.toHaveProperty(MIRRORED_TAB_ID)
    expect(next.terminalLayoutsByTabId).not.toHaveProperty(MIRRORED_TAB_ID)
    expect(next.unreadTerminalTabs).not.toHaveProperty(MIRRORED_TAB_ID)
  })

  it('keeps browser pages, handles, and certificate failures stable on exact replay', () => {
    const state = applySnapshot(makeState(), makeBrowserSnapshot())

    const replayed = applyWebSessionTabsSnapshot(
      state,
      makeBrowserSnapshot(),
      ENVIRONMENT_ID,
      NOW + 1
    )

    expect(replayed).toBe(state)
  })

  it('updates browser metadata without replacing handles or certificate failures', () => {
    const state = applySnapshot(makeState(), makeBrowserSnapshot())
    const next = applySnapshot(
      state,
      makeBrowserSnapshot({
        title: 'Changed title',
        url: 'https://example.com/changed',
        loading: true
      }),
      NOW + 1
    )

    expect(next.browserPagesByWorkspace).not.toBe(state.browserPagesByWorkspace)
    expect(next.remoteBrowserPageHandlesByPageId).toBe(state.remoteBrowserPageHandlesByPageId)
    expect(next.browserCertificateFailuresByPageId).toBe(state.browserCertificateFailuresByPageId)
  })

  it('clears a same-page certificate failure without replacing its page or handle', () => {
    const state = applySnapshot(makeState(), makeBrowserSnapshot())
    const next = applySnapshot(state, makeBrowserSnapshot({ certificateFailure: null }), NOW + 1)

    expect(next.browserPagesByWorkspace).toBe(state.browserPagesByWorkspace)
    expect(next.remoteBrowserPageHandlesByPageId).toBe(state.remoteBrowserPageHandlesByPageId)
    expect(next.browserCertificateFailuresByPageId).not.toBe(
      state.browserCertificateFailuresByPageId
    )
    expect(next.browserCertificateFailuresByPageId).not.toHaveProperty('host-browser-page-1')
  })

  // Why: a client-hosted page's certificate failure is recorded by the local guest webview and is
  // structurally absent from what the host publishes, so a host snapshot must not own that record.
  it('keeps a locally recorded certificate failure for a client-hosted page', () => {
    const state = applySnapshot(
      makeState({
        browserCertificateFailuresByPageId: { 'host-browser-page-1': CERTIFICATE_FAILURE }
      }),
      makeBrowserSnapshot({ certificateFailure: null, placement: CLIENT_PLACEMENT })
    )
    const next = applySnapshot(
      state,
      makeBrowserSnapshot({
        certificateFailure: null,
        placement: CLIENT_PLACEMENT,
        title: 'Changed title',
        loading: true
      }),
      NOW + 1
    )

    expect(next.browserCertificateFailuresByPageId['host-browser-page-1']).toEqual(
      CERTIFICATE_FAILURE
    )
  })

  // Why: same structural gap as the certificate record — the host publishes no loadError for a
  // client-hosted page, so the pane's failure overlay would vanish on the next metadata snapshot.
  it('keeps a locally recorded load failure for a client-hosted page', () => {
    const state = withLocalLoadFailure(
      applySnapshot(
        makeState(),
        makeBrowserSnapshot({ certificateFailure: null, placement: CLIENT_PLACEMENT })
      )
    )
    const next = applySnapshot(
      state,
      makeBrowserSnapshot({
        certificateFailure: null,
        placement: CLIENT_PLACEMENT,
        title: 'Changed title',
        loading: true
      }),
      NOW + 1
    )

    expect(next.browserPagesByWorkspace['host-browser-workspace']?.[0]?.loadError).toEqual(
      LOAD_ERROR
    )
    expect(next.browserTabsByWorktree[WORKTREE_A]?.[0]?.loadError).toEqual(LOAD_ERROR)
  })

  // Why: a host that omits placement and one that publishes 'server' must land on the same side
  // of the carve-out, or the tests cannot tell the client check apart from an absence check.
  it.each([
    ['an unplaced page', undefined],
    ['an explicitly server-placed page', SERVER_PLACEMENT]
  ])('still lets the host clear a load failure for %s', (_label, placement) => {
    const state = withLocalLoadFailure(
      applySnapshot(makeState(), makeBrowserSnapshot({ certificateFailure: null, placement }))
    )
    const next = applySnapshot(
      state,
      makeBrowserSnapshot({ certificateFailure: null, placement, title: 'Changed title' }),
      NOW + 1
    )

    expect(next.browserPagesByWorkspace['host-browser-workspace']?.[0]?.loadError).toBeNull()
  })

  it.each([
    ['an unplaced page', undefined],
    ['an explicitly server-placed page', SERVER_PLACEMENT]
  ])('still lets the host clear a certificate failure for %s', (_label, placement) => {
    const state = applySnapshot(
      makeState({
        browserCertificateFailuresByPageId: { 'host-browser-page-1': CERTIFICATE_FAILURE }
      }),
      makeBrowserSnapshot({ certificateFailure: null, placement })
    )

    expect(state.browserCertificateFailuresByPageId).not.toHaveProperty('host-browser-page-1')
  })

  it('cleans up replaced browser page handles and certificate failures', () => {
    const state = applySnapshot(makeState(), makeBrowserSnapshot())
    const next = applySnapshot(
      state,
      makeBrowserSnapshot({
        pageId: 'host-browser-page-2',
        certificateFailure: null
      }),
      NOW + 1
    )

    expect(next.browserPagesByWorkspace['host-browser-workspace']?.map((page) => page.id)).toEqual([
      'host-browser-page-2'
    ])
    expect(next.remoteBrowserPageHandlesByPageId).not.toHaveProperty('host-browser-page-1')
    expect(next.remoteBrowserPageHandlesByPageId['host-browser-page-2']).toEqual({
      environmentId: ENVIRONMENT_ID,
      remotePageId: 'host-browser-page-2'
    })
    expect(next.browserCertificateFailuresByPageId).not.toHaveProperty('host-browser-page-1')
  })

  it('keeps resource maps stable across an unchanged multi-worktree browser batch', () => {
    const snapshots = [
      makeBrowserSnapshot({ worktree: WORKTREE_A }),
      makeBrowserSnapshot({
        worktree: WORKTREE_B,
        tabId: 'host-browser-tab-2',
        workspaceId: 'host-browser-workspace-2',
        pageId: 'host-browser-page-2'
      })
    ]
    const initial = applyWebSessionTabsSnapshots(makeState(), snapshots, ENVIRONMENT_ID, NOW)
    const state = { ...makeState(), ...initial }

    const replayed = applyWebSessionTabsSnapshots(state, snapshots, ENVIRONMENT_ID, NOW + 1)

    expect(replayed).toBe(state)
  })

  it('preserves unchanged browser resources when a sibling worktree replaces its page', () => {
    const worktreeBSnapshot = makeBrowserSnapshot({
      worktree: WORKTREE_B,
      tabId: 'host-browser-tab-2',
      workspaceId: 'host-browser-workspace-2',
      pageId: 'host-browser-page-2'
    })
    const initial = applyWebSessionTabsSnapshots(
      makeState(),
      [makeBrowserSnapshot(), worktreeBSnapshot],
      ENVIRONMENT_ID,
      NOW
    )
    const state = { ...makeState(), ...initial }
    const pages = state.browserPagesByWorkspace['host-browser-workspace-2']
    const page = pages?.[0]
    const handle = state.remoteBrowserPageHandlesByPageId['host-browser-page-2']
    const certificate = state.browserCertificateFailuresByPageId['host-browser-page-2']

    const patch = applyWebSessionTabsSnapshots(
      state,
      [
        makeBrowserSnapshot({ pageId: 'host-browser-page-3', certificateFailure: null }),
        worktreeBSnapshot
      ],
      ENVIRONMENT_ID,
      NOW + 1
    )
    const next = { ...state, ...patch }

    expect(next.browserPagesByWorkspace['host-browser-workspace-2']).toBe(pages)
    expect(next.browserPagesByWorkspace['host-browser-workspace-2']?.[0]).toBe(page)
    expect(next.remoteBrowserPageHandlesByPageId['host-browser-page-2']).toBe(handle)
    expect(next.browserCertificateFailuresByPageId['host-browser-page-2']).toBe(certificate)
  })

  it('preserves a sibling runtime mirror under the same bare worktree id', () => {
    const firstSnapshot = makeBrowserSnapshot({
      workspaceId: 'browser-workspace-a',
      pageId: 'browser-page-a',
      tabId: 'browser-tab-a'
    })
    const firstPatch = applyWebSessionTabsSnapshot(makeState(), firstSnapshot, 'runtime-a', NOW)
    const first = { ...makeState(), ...firstPatch }
    const secondSnapshot = makeBrowserSnapshot({
      workspaceId: 'browser-workspace-b',
      pageId: 'browser-page-b',
      tabId: 'browser-tab-b'
    })
    const secondPatch = applyWebSessionTabsSnapshot(first, secondSnapshot, 'runtime-b', NOW + 1)
    const both = { ...first, ...secondPatch }

    expect(
      both.unifiedTabsByWorktree[WORKTREE_A]?.map((tab) => [tab.entityId, tab.executionHostId])
    ).toEqual([
      ['browser-workspace-a', 'runtime:runtime-a'],
      ['browser-workspace-b', 'runtime:runtime-b']
    ])

    const removalPatch = applyWebSessionTabsSnapshot(
      both,
      makeSnapshot(WORKTREE_A, [], null),
      'runtime-b',
      NOW + 2
    )
    const afterRemoval = { ...both, ...removalPatch }
    expect(
      afterRemoval.unifiedTabsByWorktree[WORKTREE_A]?.map((tab) => [
        tab.entityId,
        tab.executionHostId
      ])
    ).toEqual([['browser-workspace-a', 'runtime:runtime-a']])
  })

  it('emits no store updates for 128 accepted identical resource frames', () => {
    const terminal = makeTerminalSnapshot()
    const browser = makeBrowserSnapshot()
    const snapshot = {
      ...browser,
      tabs: [...terminal.tabs.map((tab) => ({ ...tab, isActive: false })), ...browser.tabs]
    }
    const store = createStore<WebSessionTabsSyncState>(() => makeState())
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    store.setState((state) =>
      applyFreshWebSessionTabsSnapshot(state, snapshot, ENVIRONMENT_ID, NOW)
    )
    notifications = 0
    const initial = store.getState()

    for (let snapshotVersion = 2; snapshotVersion <= 129; snapshotVersion += 1) {
      store.setState((state) =>
        applyFreshWebSessionTabsSnapshot(
          state,
          { ...snapshot, snapshotVersion },
          ENVIRONMENT_ID,
          NOW + snapshotVersion
        )
      )
    }

    expect(notifications).toBe(0)
    expect(store.getState()).toBe(initial)
  })
})
