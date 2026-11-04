import { beforeEach, describe, expect, it } from 'vitest'
import { createStore } from 'zustand/vanilla'
import 'zustand/shallow'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import '../../../shared/terminal-surface-id'
import type { BrowserCertificateFailure } from '../../../shared/browser-workspace-types'
import type { RuntimeBrowserPlacement } from '../../../shared/runtime-browser-placement'
import {
  applyWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshot
} from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'

const ENVIRONMENT_ID = 'web-env-1'
const NOW = 1_700_000_000_000
const WORKTREE_A = 'repo::/worktree-a'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_TAB_ID = 'host-tab-1'

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
    editorBuffers: {},
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

describe('remote mirror resource identity', () => {
  beforeEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
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
