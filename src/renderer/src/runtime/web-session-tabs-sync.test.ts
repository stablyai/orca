/* eslint-disable max-lines -- Why: these tests cover one reconciliation boundary
 * across ready, pending, split, and batched session snapshots. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { posix as pathPosix } from 'node:path'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import {
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  clearWebSessionCloseIntent,
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import {
  recordWebSessionReorderIntent,
  resetWebSessionReorderIntentForTests
} from './web-session-reorder-intent'
import type { BrowserPage, BrowserWorkspace, Tab, TerminalTab } from '../../../shared/types'
import type { OpenFile } from '../store/slices/editor'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  recordWebAgentSessionHandoff,
  resetWebAgentSessionHandoffsForTests
} from './web-agent-session-handoff'
import {
  _getWebSessionTabsTrackingCountsForTest,
  acceptReplayedWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  clearWebSessionTabsTrackingForEnvironment,
  resolveHostSessionTabIdForWebSessionTab,
  resetWebSessionTabsSnapshotFreshnessForTests,
  shouldSyncAllRuntimeSessionTabs,
  shouldApplyWebSessionTabsSnapshot,
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const WT = 'repo::/worktree'
const ENV = 'web-env-1'
const NOW = 1_700_000_000_000
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const HOST_SURFACE_ID = `host-tab-1::${LEAF_ID}`

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
    activeWorktreeId: WT,
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
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: tabs.find((tab) => tab.type === 'terminal' && tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs,
    ...overrides
  }
}

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebSessionFocusIntentForTests()
    resetWebSessionCloseIntentForTests()
    resetWebSessionReorderIntentForTests()
    resetWebAgentSessionHandoffsForTests()
  })

  it('ignores stale or duplicate same-epoch snapshots after a newer version was applied', () => {
    const state = makeState()
    const newer = makeSnapshot([], { snapshotVersion: 3, activeTabType: null })
    const older = makeSnapshot([], { snapshotVersion: 2, activeTabType: null })

    const first = applyFreshWebSessionTabsSnapshot(state, newer, ENV, NOW)
    const afterNewer = { ...state, ...(first as Partial<WebSessionTabsSyncState>) }
    const second = applyFreshWebSessionTabsSnapshot(afterNewer, older, ENV, NOW)

    expect(second).toBe(afterNewer)
    expect(applyFreshWebSessionTabsSnapshot(afterNewer, newer, ENV, NOW)).toBe(afterNewer)
  })

  it('applies a lower-version snapshot from a different epoch (host restart safety)', () => {
    // Why: snapshotVersion resets when the host restarts, and a restart produces
    // a new publicationEpoch. Since the client's freshness tracking survives a
    // transparent transport reconnect, rejecting on version alone would
    // permanently drop the post-restart snapshot. A different epoch must apply
    // even at a lower version; only same-epoch non-newer frames are stale.
    const before = makeSnapshot([], {
      publicationEpoch: 'epoch-gen-1',
      snapshotVersion: 10,
      activeTabType: null
    })
    const afterRestart = makeSnapshot([], {
      publicationEpoch: 'epoch-gen-2',
      snapshotVersion: 1,
      activeTabType: null
    })

    expect(shouldApplyWebSessionTabsSnapshot(before, ENV)).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(afterRestart, ENV)).toBe(true)
    // Same-epoch non-newer frames are still rejected as stale/duplicate.
    const sameEpochOlder = makeSnapshot([], {
      publicationEpoch: 'epoch-gen-2',
      snapshotVersion: 1,
      activeTabType: null
    })
    expect(shouldApplyWebSessionTabsSnapshot(sameEpochOlder, ENV)).toBe(false)
  })

  it('accepts a replayed same-epoch same-version snapshot after a transport reconnect', () => {
    // Why: after a shared-control reconnect the server re-emits the current
    // snapshot with an UNCHANGED epoch/version (the host did not restart).
    // Without the replay reset the monotonic gate rejects it and the mirror
    // stays frozen (#7718).
    const snapshot = makeSnapshot([], { snapshotVersion: 5, activeTabType: null })

    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
    // Same frame again during normal operation: still rejected as stale.
    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(false)

    acceptReplayedWebSessionTabsSnapshot(ENV, snapshot.worktree)
    const older = makeSnapshot([], { snapshotVersion: 4, activeTabType: null })
    expect(shouldApplyWebSessionTabsSnapshot(older, ENV)).toBe(false)
    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)

    // The replay reset re-primes tracking: ordering protection resumes for
    // subsequent frames (an older same-epoch frame is still rejected).
    expect(shouldApplyWebSessionTabsSnapshot(older, ENV)).toBe(false)
    const newer = makeSnapshot([], { snapshotVersion: 6, activeTabType: null })
    expect(shouldApplyWebSessionTabsSnapshot(newer, ENV)).toBe(true)
  })

  it('scopes the replay reset to the replayed environment and worktree', () => {
    const snapshot = makeSnapshot([], { snapshotVersion: 5, activeTabType: null })
    const otherWorktree = makeSnapshot([], {
      worktree: 'repo::/other-worktree',
      snapshotVersion: 5,
      activeTabType: null
    })

    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
    expect(shouldApplyWebSessionTabsSnapshot(otherWorktree, ENV)).toBe(true)

    acceptReplayedWebSessionTabsSnapshot(ENV, snapshot.worktree)

    // Only the replayed worktree re-applies; the other stays gated.
    expect(shouldApplyWebSessionTabsSnapshot(otherWorktree, ENV)).toBe(false)
    expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
  })

  it('ignores remote snapshots for the local floating workspace', () => {
    const floatingTab: TerminalTab = {
      id: 'floating-tab-1',
      ptyId: 'pty-floating-1',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      title: 'VPS tmux',
      defaultTitle: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }
    const floatingUnifiedTab: Tab = {
      id: floatingTab.id,
      entityId: floatingTab.id,
      groupId: 'floating-group',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      contentType: 'terminal',
      label: floatingTab.title,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false
    }
    const state = makeState({
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingTab] },
      ptyIdsByTabId: { [floatingTab.id]: ['pty-floating-1'] },
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [floatingUnifiedTab] },
      groupsByWorktree: {
        [FLOATING_TERMINAL_WORKTREE_ID]: [
          {
            id: 'floating-group',
            worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
            activeTabId: floatingTab.id,
            tabOrder: [floatingTab.id],
            recentTabIds: [floatingTab.id]
          }
        ]
      },
      activeTabId: floatingTab.id,
      activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: floatingTab.id }
    })

    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([], {
        worktree: FLOATING_TERMINAL_WORKTREE_ID,
        activeTabId: null,
        activeTabType: null
      }),
      ENV,
      NOW
    )

    expect(patch).toBe(state)
  })

  it('suppresses a tab the client is closing until the host confirms removal (no close flash)', () => {
    const surface = {
      type: 'terminal' as const,
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'Terminal',
      status: 'ready' as const,
      terminal: 'term_host',
      isActive: true
    }
    // Client closed host-tab-1; an in-flight pre-close snapshot still lists it.
    recordWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-1', NOW)
    const stalePreClose = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([surface]),
      ENV,
      NOW
    )
    expect((stalePreClose.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)).not.toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )

    // The host's post-close snapshot omits the tab -> intent clears; a later
    // snapshot that re-adds the SAME id (a genuinely new tab) is no longer hidden.
    applyWebSessionTabsSnapshot(makeState(), makeSnapshot([]), ENV, NOW + 1)
    const reopened = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([surface], { snapshotVersion: 5 }),
      ENV,
      NOW + 2
    )
    expect((reopened.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)).toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )
  })

  it('reapplies an unchanged host snapshot after a lifecycle close is refused', () => {
    const surface = {
      type: 'terminal' as const,
      id: HOST_SURFACE_ID,
      parentTabId: 'host-tab-1',
      leafId: LEAF_ID,
      title: 'Terminal',
      status: 'ready' as const,
      terminal: 'term_host',
      isActive: true
    }
    const authoritative = makeSnapshot([surface], { snapshotVersion: 6 })

    const initial = makeState()
    recordWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-1', NOW)
    const hiddenPatch = applyFreshWebSessionTabsSnapshot(initial, authoritative, ENV, NOW)
    const hidden = { ...initial, ...(hiddenPatch as Partial<WebSessionTabsSyncState>) }
    expect((hidden.tabsByWorktree[WT] ?? []).map((tab) => tab.id)).not.toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )

    // The host vetoed lifecycle cleanup because the PTY is still live. Its
    // unchanged snapshot must become usable immediately, without a new publish.
    clearWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-1')
    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const restoredPatch = applyFreshWebSessionTabsSnapshot(hidden, authoritative, ENV, NOW + 1)
    const restored = { ...hidden, ...(restoredPatch as Partial<WebSessionTabsSyncState>) }
    expect((restored.tabsByWorktree[WT] ?? []).map((tab) => tab.id)).toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )
  })

  it('does not let a replay reset clear another close intent from an older snapshot', () => {
    const current = makeSnapshot([], { snapshotVersion: 6, activeTabType: null })
    expect(shouldApplyWebSessionTabsSnapshot(current, ENV)).toBe(true)
    recordWebSessionCloseIntent({ environmentId: ENV }, WT, 'host-tab-2', NOW)

    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const state = makeState()
    const stalePatch = applyFreshWebSessionTabsSnapshot(
      state,
      makeSnapshot([], { snapshotVersion: 5, activeTabType: null }),
      ENV,
      NOW + 1
    )

    expect(stalePatch).toBe(state)
    expect(isWebSessionCloseIntentPending({ environmentId: ENV }, WT, 'host-tab-2', NOW + 1)).toBe(
      true
    )
  })

  it('keeps a client reorder until the host echoes it (no order snap-back)', () => {
    const local1 = toWebTerminalSurfaceTabId('host-tab-1')
    const local2 = toWebTerminalSurfaceTabId('host-tab-2')
    const surfaces: RuntimeMobileSessionTabsResult['tabs'] = [
      {
        type: 'terminal',
        id: `host-tab-1::${LEAF_ID}`,
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        title: 'Terminal 1',
        status: 'ready',
        terminal: 'term_host_1',
        isActive: true
      },
      {
        type: 'terminal',
        id: `host-tab-2::${SECOND_LEAF_ID}`,
        parentTabId: 'host-tab-2',
        leafId: SECOND_LEAF_ID,
        title: 'Terminal 2',
        status: 'ready',
        terminal: 'term_host_2',
        isActive: false
      }
    ]
    const groupWithOrder = (tabOrder: string[]): RuntimeMobileSessionTabsResult['tabGroups'] => [
      { id: 'host-group-1', activeTabId: 'host-tab-1', tabOrder }
    ]

    // Client dragged tab 2 ahead of tab 1; an in-flight snapshot still has the
    // original host order.
    recordWebSessionReorderIntent({ environmentId: ENV }, WT, 'host-group-1', [local2, local1], NOW)
    const stalePreMove = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(surfaces, { tabGroups: groupWithOrder(['host-tab-1', 'host-tab-2']) }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    expect(stalePreMove.groupsByWorktree?.[WT]?.[0]?.tabOrder).toEqual([local2, local1])

    // The host's post-move snapshot echoes the new order -> intent clears; a
    // later snapshot reverting to the old order is no longer overridden.
    applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(surfaces, {
        snapshotVersion: 5,
        tabGroups: groupWithOrder(['host-tab-2', 'host-tab-1'])
      }),
      ENV,
      NOW + 1
    )
    const reverted = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(surfaces, {
        snapshotVersion: 6,
        tabGroups: groupWithOrder(['host-tab-1', 'host-tab-2'])
      }),
      ENV,
      NOW + 2
    ) as Partial<WebSessionTabsSyncState>
    expect(reverted.groupsByWorktree?.[WT]?.[0]?.tabOrder).toEqual([local1, local2])
  })

  it('does not bootstrap a terminal from a stale empty active-worktree snapshot', () => {
    const ready = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        title: 'Terminal',
        status: 'ready',
        terminal: 'term_host',
        isActive: true
      }
    ])
    const staleEmpty = makeSnapshot([], {
      publicationEpoch: ready.publicationEpoch,
      snapshotVersion: ready.snapshotVersion - 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(shouldApplyWebSessionTabsSnapshot(ready, ENV)).toBe(true)
    const staleIsFresh = shouldApplyWebSessionTabsSnapshot(staleEmpty, ENV)

    expect(staleIsFresh).toBe(false)
    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...staleEmpty },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: staleIsFresh,
        localTerminalCount: 0
      })
    ).toBe(false)
  })

  it('does not bootstrap a terminal from a fresh empty snapshot when local terminals already exist', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: true,
        localTerminalCount: 1
      })
    ).toBe(false)
  })

  it('does not respawn after wake when activation already requested a respawn', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldRespawnWebRuntimeTerminalAfterWake({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedRespawnAfterWake: false,
        snapshotIsFresh: true,
        localTerminalCount: 1,
        hasLiveLocalPty: false,
        skipWakeRespawn: true
      })
    ).toBe(false)
  })

  it('respawns a terminal after wake when local slept tabs exist but the host snapshot is empty', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldRespawnWebRuntimeTerminalAfterWake({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedRespawnAfterWake: false,
        snapshotIsFresh: true,
        localTerminalCount: 1,
        hasLiveLocalPty: false
      })
    ).toBe(true)
  })

  it('syncs active session tabs for desktop remote runtime clients using the worktree owner', () => {
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: true
      })
    ).toBe(true)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: null,
        workspaceSessionReady: true
      })
    ).toBe(false)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: 'other-env',
        workspaceSessionReady: true
      })
    ).toBe(true)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: true
      })
    ).toBe(false)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: false
      })
    ).toBe(false)
  })

  it('starts the all-session mirror for desktop and paired web clients', () => {
    expect(
      shouldSyncAllRuntimeSessionTabs({
        activeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: true
      })
    ).toBe(true)
    expect(
      shouldSyncAllRuntimeSessionTabs({
        activeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: false
      })
    ).toBe(false)
  })

  it('clears web session tracking maps when the host removes a worktree snapshot', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const unifiedTab: Tab = {
      id: 'local-browser-unified',
      entityId: workspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: 'New Tab',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }

    const patch = applyFreshWebSessionTabsSnapshot(
      makeState({
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const afterHostSnapshot = {
      ...makeState(),
      ...patch
    } as WebSessionTabsSyncState

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 1,
      hostMappings: 1
    })

    applyFreshWebSessionTabsSnapshot(
      afterHostSnapshot,
      {
        ...makeSnapshot([], {
          publicationEpoch: 'removed-epoch',
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null
        }),
        removed: true
      } as RuntimeMobileSessionTabsResult,
      ENV,
      NOW + 1
    )

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 0,
      hostMappings: 0
    })
  })

  it('clears web session tracking maps for one runtime environment on teardown', () => {
    applyFreshWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    )
    applyFreshWebSessionTabsSnapshot(
      makeState({ activeWorktreeId: 'repo::/other-worktree' }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'other-host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'other-host-browser-workspace',
            browserPageId: 'other-host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        {
          worktree: 'repo::/other-worktree',
          activeTabId: 'other-host-browser-unified',
          activeTabType: 'browser'
        }
      ),
      'web-env-2',
      NOW
    )

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 2,
      hostMappings: 2
    })

    clearWebSessionTabsTrackingForEnvironment(ENV)

    expect(_getWebSessionTabsTrackingCountsForTest()).toEqual({
      freshness: 1,
      hostMappings: 1
    })
  })

  it('keeps a provisional Claude tab when the host Claude surface is unrelated', () => {
    const staleLocalAgentTab: TerminalTab = {
      id: 'local-agent-tab',
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }
    const staleUnifiedTab: Tab = {
      id: 'local-agent-tab',
      entityId: 'local-agent-tab',
      groupId: 'group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [staleLocalAgentTab] },
        unifiedTabsByWorktree: { [WT]: [staleUnifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'group-1',
              worktreeId: WT,
              activeTabId: 'local-agent-tab',
              tabOrder: ['local-agent-tab']
            }
          ]
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(2)
    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'local-agent-tab')).toBe(true)
    expect(patch.unifiedTabsByWorktree?.[WT]?.some((tab) => tab.id === 'local-agent-tab')).toBe(
      true
    )
  })

  it('replaces only the provisional tab with an exact structured-create handoff', () => {
    const provisional = (id: string): TerminalTab => ({
      id,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-b',
      hostTabId: 'host-tab-1',
      hostTerminalHandle: 'term_host-1'
    })

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: {
          [WT]: [provisional('provisional-a'), provisional('provisional-b')]
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'provisional-a')).toBe(true)
    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'provisional-b')).toBe(false)
    expect(patch.tabsByWorktree?.[WT]).toHaveLength(2)
  })

  it('retires an exact provisional handoff only after a post-create snapshot confirms exit', () => {
    const provisional = (id: string): TerminalTab => ({
      id,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-exited',
      hostTabId: 'host-tab-exited',
      hostTerminalHandle: 'term_host-exited'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-unrelated',
      hostTabId: 'host-tab-still-in-flight',
      hostTerminalHandle: 'term_host-in-flight'
    })

    const state = makeState({
      tabsByWorktree: {
        [WT]: [provisional('provisional-unrelated'), provisional('provisional-exited')]
      }
    })
    const possiblyPreCreate = applyWebSessionTabsSnapshot(state, makeSnapshot([]), ENV, NOW)
    const possiblyPreCreateState = {
      ...state,
      ...(possiblyPreCreate as Partial<WebSessionTabsSyncState>)
    }
    expect(possiblyPreCreateState.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([
      'provisional-unrelated',
      'provisional-exited'
    ])

    confirmWebAgentSessionHandoffAfterCreate({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-exited',
      hostTabId: 'host-tab-exited',
      hostTerminalHandle: 'term_host-exited'
    })
    const postCreate = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(postCreate.tabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual(['provisional-unrelated'])
  })

  it('cleans provisional startup and automatic-resume state during exact handoff', () => {
    const provisionalTab: TerminalTab = {
      id: 'provisional-resume',
      ptyId: null,
      worktreeId: WT,
      title: 'Codex',
      defaultTitle: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'codex'
    }
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: provisionalTab.id,
      hostTabId: 'host-tab-1',
      hostTerminalHandle: 'term_host-1'
    })

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [provisionalTab] },
        pendingStartupByTabId: {
          [provisionalTab.id]: { command: "codex resume 'session-b'" },
          retained: { command: 'codex' }
        },
        automaticAgentResumeClaimsByTabId: {
          [provisionalTab.id]: {
            worktreeId: WT,
            launchAgent: 'codex',
            providerSession: { key: 'session_id', id: 'session-b' }
          },
          retained: {
            worktreeId: WT,
            launchAgent: 'codex',
            providerSession: { key: 'session_id', id: 'session-a' }
          }
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'codex',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.pendingStartupByTabId).toEqual({ retained: { command: 'codex' } })
    expect(patch.automaticAgentResumeClaimsByTabId).toEqual({
      retained: {
        worktreeId: WT,
        launchAgent: 'codex',
        providerSession: { key: 'session_id', id: 'session-a' }
      }
    })
  })

  it('keeps stale local agent tabs when the host mirror is for a different agent', () => {
    const staleLocalClaudeTab: TerminalTab = {
      id: 'local-claude-tab',
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [staleLocalClaudeTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'codex',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(2)
    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'local-claude-tab')).toBe(true)
  })

  it('hydrates ready host terminal surfaces as remote runtime terminal tabs', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'codex',
          startupCwd: '/worktree/packages/web',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).toBeTruthy()
    expect(mirroredId).not.toContain(':')
    expect(() => makePaneKey(mirroredId!, LEAF_ID)).not.toThrow()
    expect(patch.tabsByWorktree?.[WT]).toMatchObject([
      {
        id: mirroredId,
        ptyId: 'remote:web-env-1@@terminal-1',
        launchAgent: 'codex',
        startupCwd: '/worktree/packages/web',
        title: 'host shell',
        worktreeId: WT
      }
    ])
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toEqual(['remote:web-env-1@@terminal-1'])
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      ptyIdsByLeafId: { [LEAF_ID]: 'remote:web-env-1@@terminal-1' }
    })
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]?.titlesByLeafId).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      id: 'host-group-1',
      activeTabId: mirroredId,
      tabOrder: [mirroredId]
    })
    expect(patch.activeTabId).toBe(mirroredId)
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(mirroredId)
  })

  it('drops mirrored launch intent when a later host snapshot omits it', () => {
    const existingTab: TerminalTab = {
      id: toWebTerminalSurfaceTabId('host-tab-1'),
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'Codex',
      defaultTitle: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'codex'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [existingTab.id]: ['remote:web-env-1@@terminal-1'] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: existingTab.id,
      title: 'zsh'
    })
    expect(patch.tabsByWorktree?.[WT]?.[0]?.launchAgent).toBeUndefined()
  })

  it('drops mirrored startup cwd when a later host snapshot omits it', () => {
    const existingTab: TerminalTab = {
      id: toWebTerminalSurfaceTabId('host-tab-1'),
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      startupCwd: '/worktree/packages/web'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [existingTab.id]: ['remote:web-env-1@@terminal-1'] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: existingTab.id,
      title: 'zsh'
    })
    expect(patch.tabsByWorktree?.[WT]?.[0]?.startupCwd).toBeUndefined()
  })

  it('adopts host viewMode when this client has no prior tab', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          viewMode: 'chat',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.tabsByWorktree?.[WT]?.[0]?.viewMode).toBe('chat')
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)?.viewMode
    ).toBe('chat')
  })

  it('keeps the client viewMode when an in-flight host snapshot echoes the old value', () => {
    // Echo-window: client just toggled to chat; a host snapshot carrying the
    // pre-toggle 'terminal' value must not revert it (mirrors color/pin rule).
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'old title',
      defaultTitle: 'old title',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      viewMode: 'chat'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          // Title differs so the reconcile emits a tabsByWorktree delta; the echo
          // rule must still keep the client's optimistic 'chat' viewMode.
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          viewMode: 'terminal',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]?.title).toBe('new title')
    expect(patch.tabsByWorktree?.[WT]?.[0]?.viewMode).toBe('chat')
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)?.viewMode
    ).toBe('chat')
  })

  it('preserves quick command labels from host terminal surfaces', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Run tests',
          quickCommandLabel: 'Run tests',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredId,
      quickCommandLabel: 'Run tests',
      title: 'Run tests'
    })
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.quickCommandLabel
    ).toBe('Run tests')
  })

  it('removes stale scrollback refs from mirrored terminal layouts', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const ptyId = 'remote:web-env-1@@terminal-1'
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId,
      worktreeId: WT,
      title: 'host shell',
      defaultTitle: 'host shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: [ptyId] },
        terminalLayoutsByTabId: {
          [mirroredId]: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: ptyId },
            scrollbackRefsByLeafId: { [LEAF_ID]: 'v1-stale-ref' }
          }
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.terminalLayoutsByTabId?.[mirroredId]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: ptyId }
    })
    expect(patch.terminalLayoutsByTabId?.[mirroredId]?.scrollbackRefsByLeafId).toBeUndefined()
  })

  it('hydrates host split tab groups with mirrored terminal tab ids', () => {
    const rightLeafId = SECOND_LEAF_ID
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-left::${LEAF_ID}`,
            title: 'left shell',
            parentTabId: 'host-left',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-left'
          },
          {
            type: 'terminal',
            id: `host-right::${rightLeafId}`,
            title: 'right shell',
            parentTabId: 'host-right',
            leafId: rightLeafId,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-right'
          }
        ],
        {
          activeGroupId: 'group-right',
          activeTabId: `host-right::${rightLeafId}`,
          tabGroups: [
            { id: 'group-left', activeTabId: 'host-left', tabOrder: ['host-left'] },
            { id: 'group-right', activeTabId: 'host-right', tabOrder: ['host-right'] }
          ],
          tabGroupLayout: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-left' },
            second: { type: 'leaf', groupId: 'group-right' }
          }
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const leftId = patch.tabsByWorktree?.[WT]?.find((tab) => tab.title === 'left shell')?.id
    const rightId = patch.tabsByWorktree?.[WT]?.find((tab) => tab.title === 'right shell')?.id

    expect(leftId).toBeTruthy()
    expect(rightId).toBeTruthy()
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: leftId, groupId: 'group-left' }),
        expect.objectContaining({ id: rightId, groupId: 'group-right' })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]).toEqual([
      {
        id: 'group-left',
        worktreeId: WT,
        activeTabId: leftId,
        tabOrder: [leftId],
        recentTabIds: [leftId]
      },
      {
        id: 'group-right',
        worktreeId: WT,
        activeTabId: rightId,
        tabOrder: [rightId],
        recentTabIds: [rightId]
      }
    ])
    expect(patch.layoutByWorktree?.[WT]).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    })
    expect(patch.activeGroupIdByWorktree?.[WT]).toBe('group-right')
  })

  it('assigns mirrored terminal, browser, and editor tabs to their host split groups', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-terminal::${LEAF_ID}`,
            title: 'host shell',
            parentTabId: 'host-terminal',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: false
          },
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        {
          activeGroupId: 'group-editor',
          activeTabId: 'host-readme-unified',
          activeTabType: 'markdown',
          tabGroups: [
            { id: 'group-terminal', activeTabId: 'host-terminal', tabOrder: ['host-terminal'] },
            {
              id: 'group-browser',
              activeTabId: 'host-browser-unified',
              tabOrder: ['host-browser-unified']
            },
            {
              id: 'group-editor',
              activeTabId: 'host-readme-unified',
              tabOrder: ['host-readme-unified']
            }
          ],
          tabGroupLayout: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-terminal' },
            second: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', groupId: 'group-browser' },
              second: { type: 'leaf', groupId: 'group-editor' }
            }
          }
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const unifiedTabs = patch.unifiedTabsByWorktree?.[WT] ?? []
    const terminalTab = unifiedTabs.find((tab) => tab.contentType === 'terminal')
    const browserTab = unifiedTabs.find((tab) => tab.contentType === 'browser')
    const editorTab = unifiedTabs.find((tab) => tab.contentType === 'editor')

    expect(terminalTab).toMatchObject({ groupId: 'group-terminal' })
    expect(browserTab).toMatchObject({ id: 'host-browser-unified', groupId: 'group-browser' })
    expect(editorTab).toMatchObject({ id: 'host-readme-unified', groupId: 'group-editor' })
  })

  it('preserves local browser position when appending a new remote terminal', () => {
    const firstTerminalId = toWebTerminalSurfaceTabId('host-tab-1')
    const secondTerminalId = toWebTerminalSurfaceTabId('host-tab-2')
    const localBrowserWorkspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      label: undefined,
      sessionProfileId: null,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'about:blank',
      title: 'New Browser Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW + 1
    }
    const localBrowserPage: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: localBrowserWorkspace.id,
      worktreeId: WT,
      url: 'about:blank',
      title: 'New Browser Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW + 1,
      browserRuntimeEnvironmentId: null,
      viewportPresetId: null
    }
    const localBrowserTab: Tab = {
      id: 'local-browser-tab',
      entityId: localBrowserWorkspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: 'New Browser Tab',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: NOW + 1,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: {
          [WT]: [
            {
              id: firstTerminalId,
              ptyId: 'remote:web-env-1@@terminal-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW
            }
          ]
        },
        browserTabsByWorktree: { [WT]: [localBrowserWorkspace] },
        browserPagesByWorkspace: { [localBrowserWorkspace.id]: [localBrowserPage] },
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: firstTerminalId,
              entityId: firstTerminalId,
              groupId: 'host-group-1',
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW,
              isPreview: false,
              isPinned: false
            },
            localBrowserTab
          ]
        },
        tabBarOrderByWorktree: { [WT]: [firstTerminalId, localBrowserTab.id] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: localBrowserTab.id,
              tabOrder: [firstTerminalId, localBrowserTab.id]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-tab-1::${LEAF_ID}`,
            title: 'Terminal 1',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'terminal',
            id: `host-tab-2::${SECOND_LEAF_ID}`,
            title: 'Terminal 2',
            parentTabId: 'host-tab-2',
            leafId: SECOND_LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-2'
          }
        ],
        {
          activeTabId: `host-tab-2::${SECOND_LEAF_ID}`,
          tabGroups: [
            {
              id: 'host-group-1',
              activeTabId: 'host-tab-2',
              tabOrder: ['host-tab-1', 'host-tab-2']
            }
          ]
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabBarOrderByWorktree?.[WT]).toEqual([
      firstTerminalId,
      localBrowserTab.id,
      secondTerminalId
    ])
  })

  it('keeps retained local-only groups reachable when applying a host layout', () => {
    const localTab: Tab = {
      id: 'local-editor-tab',
      entityId: 'local-editor-file',
      groupId: 'local-group',
      worktreeId: WT,
      contentType: 'editor',
      label: 'notes.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    const currentLayout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'host-group-1' },
      second: { type: 'leaf' as const, groupId: 'local-group' }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        unifiedTabsByWorktree: { [WT]: [localTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            },
            {
              id: 'local-group',
              worktreeId: WT,
              activeTabId: localTab.id,
              tabOrder: [localTab.id],
              recentTabIds: [localTab.id]
            }
          ]
        },
        layoutByWorktree: { [WT]: currentLayout }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-terminal::${LEAF_ID}`,
            title: 'host shell',
            parentTabId: 'host-terminal',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ],
        {
          activeGroupId: 'host-group-1',
          activeTabId: `host-terminal::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [
            { id: 'host-group-1', activeTabId: 'host-terminal', tabOrder: ['host-terminal'] }
          ],
          tabGroupLayout: { type: 'leaf', groupId: 'host-group-1' }
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.groupsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-group',
          tabOrder: [localTab.id]
        })
      ])
    )
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('keeps retained local-only groups reachable when host omits layout', () => {
    const localTab: Tab = {
      id: 'local-editor-tab',
      entityId: 'local-editor-file',
      groupId: 'local-group',
      worktreeId: WT,
      contentType: 'editor',
      label: 'notes.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    const currentLayout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'host-group-1' },
      second: { type: 'leaf' as const, groupId: 'local-group' }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        unifiedTabsByWorktree: { [WT]: [localTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            },
            {
              id: 'local-group',
              worktreeId: WT,
              activeTabId: localTab.id,
              tabOrder: [localTab.id],
              recentTabIds: [localTab.id]
            }
          ]
        },
        layoutByWorktree: { [WT]: currentLayout }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-terminal::${LEAF_ID}`,
            title: 'host shell',
            parentTabId: 'host-terminal',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ],
        {
          activeGroupId: 'host-group-1',
          activeTabId: `host-terminal::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [
            { id: 'host-group-1', activeTabId: 'host-terminal', tabOrder: ['host-terminal'] }
          ]
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.groupsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-group',
          tabOrder: [localTab.id]
        })
      ])
    )
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('preserves host pane titles without synthesizing them from tab titles', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Terminal 2',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            titlesByLeafId: { [LEAF_ID]: 'user title' }
          },
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.tabsByWorktree?.[WT]?.[0]?.title).toBe('Terminal 2')
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]?.titlesByLeafId).toEqual({
      [LEAF_ID]: 'user title'
    })
  })

  it('drops stale single-pane parent titles that duplicate the host tab title', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Terminal 2',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            titlesByLeafId: { [LEAF_ID]: 'Terminal 2' }
          },
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]?.titlesByLeafId).toBeUndefined()
  })

  it('remaps host agent status onto mirrored terminal pane keys', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'codex [working]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'fix web parity',
            updatedAt: NOW - 100,
            stateStartedAt: NOW - 1_000,
            agentType: 'codex',
            paneKey: hostPaneKey,
            terminalTitle: 'codex [working]',
            stateHistory: []
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)
    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      state: 'working',
      prompt: 'fix web parity',
      agentType: 'codex',
      paneKey: mirroredPaneKey,
      terminalTitle: 'codex [working]'
    })
    expect(patch.agentStatusByPaneKey?.[hostPaneKey]).toBeUndefined()
    expect(patch.agentStatusEpoch).toBe(1)
    expect(patch.sortEpoch).toBe(1)
  })

  it('bumps aggregate epochs when a mirrored same-state entry gains attribution', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const snapshot = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'codex [working]',
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: 'fix web parity',
          updatedAt: NOW - 100,
          stateStartedAt: NOW - 1_000,
          agentType: 'codex',
          paneKey: hostPaneKey,
          worktreeId: WT,
          tabId: 'host-tab-1',
          stateHistory: []
        }
      }
    ])
    const initial = applyWebSessionTabsSnapshot(
      makeState(),
      snapshot,
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const mirroredPaneKey = Object.keys(initial.agentStatusByPaneKey ?? {})[0]!
    const existing = initial.agentStatusByPaneKey![mirroredPaneKey]!
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        ...initial,
        agentStatusByPaneKey: {
          [mirroredPaneKey]: { ...existing, worktreeId: 'stale-worktree', tabId: 'stale-tab' }
        },
        agentStatusEpoch: 7,
        sortEpoch: 11
      }),
      { ...snapshot, snapshotVersion: 2 },
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.agentStatusEpoch).toBe(8)
    expect(patch.sortEpoch).toBe(12)
  })

  it('keeps mirrored OMP tabs from repainting to Pi-compatible titles', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Pi ready',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          launchAgent: 'omp',
          agentStatus: {
            state: 'done',
            prompt: '',
            updatedAt: NOW - 100,
            stateStartedAt: NOW - 1_000,
            agentType: 'pi',
            paneKey: hostPaneKey,
            terminalTitle: 'Pi ready',
            stateHistory: []
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)
    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      title: 'OMP ready',
      launchAgent: 'omp'
    })
    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
  })

  it('bumps sort epoch for mirrored Command Code same-state turn starts', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const initialPatch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Command Code',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'same prompt',
            updatedAt: NOW - 1_000,
            stateStartedAt: NOW - 1_000,
            agentType: 'command-code',
            paneKey: hostPaneKey,
            terminalTitle: 'Command Code',
            stateHistory: [],
            promptInteractionKey: 'command-code-transcript-a'
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const initialState = { ...makeState(), ...initialPatch }
    const mirroredId = initialPatch.tabsByWorktree?.[WT]?.[0]?.id
    const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)

    const patch = applyWebSessionTabsSnapshot(
      initialState,
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'Command Code',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1',
            agentStatus: {
              state: 'working',
              prompt: 'same prompt',
              updatedAt: NOW,
              stateStartedAt: NOW,
              agentType: 'command-code',
              paneKey: hostPaneKey,
              terminalTitle: 'Command Code',
              stateHistory: [],
              promptInteractionKey: 'command-code-transcript-b'
            }
          }
        ],
        { snapshotVersion: 2 }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      prompt: 'same prompt',
      stateStartedAt: NOW,
      promptInteractionKey: 'command-code-transcript-b'
    })
    expect(patch.agentStatusEpoch).toBe((initialState.agentStatusEpoch ?? 0) + 1)
    expect(patch.sortEpoch).toBe((initialState.sortEpoch ?? 0) + 1)
  })

  it('hydrates multiple initial host snapshots in one merged patch', () => {
    const secondWorktree = 'repo::/other-worktree'
    const patch = applyWebSessionTabsSnapshots(
      makeState({ activeWorktreeId: null }),
      [
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        makeSnapshot(
          [
            {
              type: 'terminal',
              id: `host-tab-2::${SECOND_LEAF_ID}`,
              title: 'second shell',
              parentTabId: 'host-tab-2',
              leafId: SECOND_LEAF_ID,
              isActive: true,
              status: 'ready',
              terminal: 'terminal-2'
            }
          ],
          { worktree: secondWorktree, activeGroupId: 'host-group-2' }
        )
      ],
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.tabsByWorktree?.[secondWorktree]).toHaveLength(1)
    expect(patch.ptyIdsByTabId).toEqual(
      expect.objectContaining({
        [patch.tabsByWorktree?.[WT]?.[0]?.id ?? '']: ['remote:web-env-1@@terminal-1'],
        [patch.tabsByWorktree?.[secondWorktree]?.[0]?.id ?? '']: ['remote:web-env-1@@terminal-2']
      })
    )
  })

  it('replaces temporary web-created tabs once the host publishes the same PTY', () => {
    const localTab: TerminalTab = {
      id: 'local-web-tab',
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'local shell',
      defaultTitle: 'local shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 1
    }
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [localTab] },
        ptyIdsByTabId: { 'local-web-tab': ['remote:web-env-1@@terminal-1'] },
        terminalLayoutsByTabId: {
          'local-web-tab': { root: null, activeLeafId: null, expandedLeafId: null }
        },
        unreadTerminalTabs: { 'local-web-tab': true }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual([
      expect.not.stringContaining(':')
    ])
    expect(patch.ptyIdsByTabId?.['local-web-tab']).toBeUndefined()
    expect(patch.unreadTerminalTabs?.['local-web-tab']).toBeUndefined()
  })

  it('groups split host terminal panes under one web tab', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'left pane',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            expandedLeafId: null
          },
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'right pane',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          parentLayout: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            expandedLeafId: null
          },
          isActive: true,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.tabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-2',
      title: 'right pane'
    })
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toEqual([
      'remote:web-env-1@@terminal-1',
      'remote:web-env-1@@terminal-2'
    ])
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_ID },
        second: { type: 'leaf', leafId: SECOND_LEAF_ID }
      },
      activeLeafId: SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1',
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-2'
      }
    })
    expect(patch.groupsByWorktree?.[WT]?.[0]?.tabOrder).toEqual([mirroredId])
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(mirroredId)
  })

  it('does not let repeated remote terminal status snapshots steal local tab focus', () => {
    const agentTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const shellTabId = toWebTerminalSurfaceTabId('host-tab-2')
    const agentUnifiedTab: Tab = {
      id: agentTabId,
      entityId: agentTabId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'codex [working]',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    const shellUnifiedTab: Tab = {
      id: shellTabId,
      entityId: shellTabId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'shell',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: NOW + 1,
      isPreview: false,
      isPinned: false
    }

    const state = makeState({
      activeTabId: shellTabId,
      activeTabIdByWorktree: { [WT]: shellTabId },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      tabsByWorktree: {
        [WT]: [
          {
            id: agentTabId,
            ptyId: 'remote:web-env-1@@terminal-1',
            worktreeId: WT,
            title: 'codex [working]',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          },
          {
            id: shellTabId,
            ptyId: 'remote:web-env-1@@terminal-2',
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: NOW + 1
          }
        ]
      },
      unifiedTabsByWorktree: { [WT]: [agentUnifiedTab, shellUnifiedTab] },
      tabBarOrderByWorktree: { [WT]: [agentTabId, shellTabId] },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'host-group-1',
            worktreeId: WT,
            activeTabId: shellTabId,
            tabOrder: [agentTabId, shellTabId],
            recentTabIds: [agentTabId, shellTabId]
          }
        ]
      }
    })
    const remoteActiveSnapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex [thinking]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-2::${SECOND_LEAF_ID}`,
          title: 'shell',
          parentTabId: 'host-tab-2',
          leafId: SECOND_LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ],
      {
        activeTabId: `host-tab-1::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: 'host-tab-1',
            tabOrder: ['host-tab-1', 'host-tab-2']
          }
        ]
      }
    )
    const patch = applyWebSessionTabsSnapshot(
      state,
      remoteActiveSnapshot,
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.activeTabId).toBeUndefined()
    expect(patch.activeTabIdByWorktree).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      activeTabId: shellTabId,
      tabOrder: [agentTabId, shellTabId]
    })

    const followed = applyWebSessionTabsSnapshot(
      state,
      { ...remoteActiveSnapshot, navigationIntent: 'follow' },
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    expect(followed.activeTabIdByWorktree?.[WT]).toBe(agentTabId)
    expect(followed.groupsByWorktree?.[WT]?.[0]?.activeTabId).toBe(agentTabId)
  })

  it('focuses a caller-created terminal even when an older host leaves it inactive', () => {
    const existingTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const newTabId = toWebTerminalSurfaceTabId('host-tab-2')
    // Simulate createWebRuntimeSessionTerminal recording focus intent for the new tab.
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-2')
    const existingUnifiedTab: Tab = {
      id: existingTabId,
      entityId: existingTabId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'shell',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeTabId: existingTabId,
        activeTabIdByWorktree: { [WT]: existingTabId },
        activeTabType: 'terminal',
        activeTabTypeByWorktree: { [WT]: 'terminal' },
        tabsByWorktree: {
          [WT]: [
            {
              id: existingTabId,
              ptyId: 'remote:web-env-1@@terminal-1',
              worktreeId: WT,
              title: 'shell',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW
            }
          ]
        },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] },
        tabBarOrderByWorktree: { [WT]: [existingTabId] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: existingTabId,
              tabOrder: [existingTabId],
              recentTabIds: [existingTabId]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-tab-1::${LEAF_ID}`,
            title: 'shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'terminal',
            id: `host-tab-2::${SECOND_LEAF_ID}`,
            title: 'new shell',
            parentTabId: 'host-tab-2',
            leafId: SECOND_LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-2'
          }
        ],
        {
          activeTabId: `host-tab-1::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [
            {
              id: 'host-group-1',
              activeTabId: 'host-tab-1',
              tabOrder: ['host-tab-1', 'host-tab-2']
            }
          ]
        }
      ),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.activeTabIdByWorktree?.[WT]).toBe(newTabId)
    expect(patch.groupsByWorktree?.[WT]?.[0]?.activeTabId).toBe(newTabId)
  })

  it('replays a snapshot that beat the RPC response and focuses the exact adopted leaf', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const root = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, leafId: LEAF_ID },
      second: { type: 'leaf' as const, leafId: SECOND_LEAF_ID }
    }
    const currentLayout = {
      root,
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1',
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-2'
      }
    }
    const state = makeState({
      activeTabId: mirroredTabId,
      activeTabIdByWorktree: { [WT]: mirroredTabId },
      tabsByWorktree: {
        [WT]: [
          {
            id: mirroredTabId,
            ptyId: 'remote:web-env-1@@terminal-2',
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      },
      terminalLayoutsByTabId: { [mirroredTabId]: currentLayout }
    })
    const snapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: currentLayout,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'shell',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          parentLayout: currentLayout,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ],
      {
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: 'host-tab-1',
            tabOrder: ['host-tab-1']
          }
        ]
      }
    )

    const subscriptionPatch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
    const afterSubscription = {
      ...state,
      ...(subscriptionPatch as Partial<WebSessionTabsSyncState>)
    }
    expect(afterSubscription.terminalLayoutsByTabId[mirroredTabId]?.activeLeafId).toBe(
      SECOND_LEAF_ID
    )

    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-1', LEAF_ID)
    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const replayPatch = applyFreshWebSessionTabsSnapshot(
      afterSubscription,
      snapshot,
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(replayPatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe('remote:web-env-1@@terminal-1')
    expect(replayPatch.terminalLayoutsByTabId?.[mirroredTabId]).toMatchObject({
      activeLeafId: LEAF_ID,
      expandedLeafId: LEAF_ID
    })
  })

  it('retains exact-leaf focus intent when a split sibling publishes first', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const siblingPtyId = 'remote:web-env-1@@terminal-2'
    const state = makeState({
      activeTabId: mirroredTabId,
      activeTabIdByWorktree: { [WT]: mirroredTabId },
      tabsByWorktree: {
        [WT]: [
          {
            id: mirroredTabId,
            ptyId: siblingPtyId,
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      }
    })
    const sibling = {
      type: 'terminal' as const,
      id: `host-tab-1::${SECOND_LEAF_ID}`,
      title: 'shell',
      parentTabId: 'host-tab-1',
      leafId: SECOND_LEAF_ID,
      isActive: true,
      status: 'ready' as const,
      terminal: 'terminal-2'
    }
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-1', LEAF_ID)

    const partialPatch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([sibling]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    expect(partialPatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe(siblingPtyId)

    const afterPartial = { ...state, ...partialPatch }
    const completePatch = applyWebSessionTabsSnapshot(
      afterPartial,
      makeSnapshot([
        sibling,
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(completePatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe('remote:web-env-1@@terminal-1')
    expect(completePatch.terminalLayoutsByTabId?.[mirroredTabId]?.activeLeafId).toBe(LEAF_ID)
  })

  it('does not let repeated remote split status snapshots steal local pane focus', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const currentLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: LEAF_ID },
        second: { type: 'leaf' as const, leafId: SECOND_LEAF_ID }
      },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1',
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-2'
      }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeTabId: mirroredTabId,
        activeTabIdByWorktree: { [WT]: mirroredTabId },
        activeTabType: 'terminal',
        activeTabTypeByWorktree: { [WT]: 'terminal' },
        tabsByWorktree: {
          [WT]: [
            {
              id: mirroredTabId,
              ptyId: 'remote:web-env-1@@terminal-2',
              worktreeId: WT,
              title: 'right pane',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW
            }
          ]
        },
        terminalLayoutsByTabId: { [mirroredTabId]: currentLayout }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex [thinking]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            ...currentLayout,
            activeLeafId: LEAF_ID
          },
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'right pane',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          parentLayout: {
            ...currentLayout,
            activeLeafId: LEAF_ID
          },
          isActive: false,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ]),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredTabId,
      ptyId: 'remote:web-env-1@@terminal-2',
      title: 'right pane'
    })
    expect(patch.terminalLayoutsByTabId?.[mirroredTabId]?.activeLeafId).toBe(SECOND_LEAF_ID)
  })

  it('removes a null-pty pending activation tab when the host publishes the initial terminal', () => {
    const pendingTab: TerminalTab = {
      id: 'local-pending-tab',
      ptyId: null,
      worktreeId: WT,
      title: 'Terminal 1',
      defaultTitle: 'Terminal 1',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 1,
      pendingActivationSpawn: true
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [pendingTab] },
        activeTabId: pendingTab.id,
        activeTabIdByWorktree: { [WT]: pendingTab.id }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.map((tab) => tab.id)).not.toContain(pendingTab.id)
    expect(patch.activeTabIdByWorktree?.[WT]).not.toBe(pendingTab.id)
  })

  it('hydrates active host browser tabs with remote page handles', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: true,
            canGoForward: false,
            loadError: {
              code: -202,
              description: 'ERR_CERT_AUTHORITY_INVALID',
              validatedUrl: 'https://localhost:3443/'
            },
            certificateFailure: {
              challengeId: 'challenge-1',
              browserPageId: 'host-browser-page',
              errorCode: -202,
              error: 'ERR_CERT_AUTHORITY_INVALID',
              origin: 'https://localhost:3443',
              displayHost: 'localhost:3443',
              canProceed: true,
              observedAt: 123
            },
            color: '#3b82f6',
            isPinned: true,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const terminalId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.browserTabsByWorktree?.[WT]).toMatchObject([
      {
        id: 'host-browser-workspace',
        worktreeId: WT,
        activePageId: 'host-browser-page',
        pageIds: ['host-browser-page'],
        url: 'https://example.com/',
        title: 'Example Domain',
        canGoBack: true,
        canGoForward: false
      }
    ])
    expect(patch.browserPagesByWorkspace?.['host-browser-workspace']).toMatchObject([
      {
        id: 'host-browser-page',
        workspaceId: 'host-browser-workspace',
        worktreeId: WT,
        url: 'https://example.com/',
        title: 'Example Domain',
        loading: false,
        loadError: {
          code: -202,
          description: 'ERR_CERT_AUTHORITY_INVALID',
          validatedUrl: 'https://localhost:3443/'
        }
      }
    ])
    expect(patch.remoteBrowserPageHandlesByPageId?.['host-browser-page']).toEqual({
      environmentId: ENV,
      remotePageId: 'host-browser-page'
    })
    expect(patch.browserCertificateFailuresByPageId?.['host-browser-page']).toEqual({
      challengeId: 'challenge-1',
      browserPageId: 'host-browser-page',
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      canProceed: true,
      observedAt: 123
    })
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminalId,
          entityId: terminalId,
          contentType: 'terminal'
        }),
        expect.objectContaining({
          id: 'host-browser-unified',
          entityId: 'host-browser-workspace',
          contentType: 'browser',
          label: 'Example Domain',
          color: '#3b82f6',
          isPinned: true
        })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      id: 'host-group-1',
      activeTabId: 'host-browser-unified',
      tabOrder: [terminalId, 'host-browser-unified']
    })
    expect(patch.activeBrowserTabId).toBe('host-browser-workspace')
    expect(patch.activeBrowserTabIdByWorktree?.[WT]).toBe('host-browser-workspace')
    expect(patch.activeTabId).toBe(terminalId)
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(terminalId)
    expect(patch.activeTabType).toBe('browser')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('browser')
  })

  it('keeps mirrored browser tabs in a rendered web layout group', () => {
    const visibleGroupId = 'visible-web-group'
    const hostOnlyGroupId = 'host-group-1'
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeGroupIdByWorktree: { [WT]: hostOnlyGroupId },
        groupsByWorktree: {
          [WT]: [
            {
              id: visibleGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            },
            {
              id: hostOnlyGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: visibleGroupId } }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const browserUnifiedTab = patch.unifiedTabsByWorktree?.[WT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserUnifiedTab).toMatchObject({ groupId: visibleGroupId })
    expect(
      patch.groupsByWorktree?.[WT]?.find((group) => group.id === visibleGroupId)
    ).toMatchObject({
      activeTabId: 'host-browser-unified',
      tabOrder: ['host-browser-unified']
    })
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('creates a rendered web layout group when stale group records do not include it', () => {
    const visibleGroupId = 'visible-web-group'
    const hostOnlyGroupId = 'host-group-1'
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeGroupIdByWorktree: { [WT]: hostOnlyGroupId },
        groupsByWorktree: {
          [WT]: [
            {
              id: hostOnlyGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: visibleGroupId } }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const browserUnifiedTab = patch.unifiedTabsByWorktree?.[WT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserUnifiedTab).toMatchObject({ groupId: visibleGroupId })
    expect(patch.groupsByWorktree?.[WT]).toEqual([
      expect.objectContaining({
        id: visibleGroupId,
        activeTabId: 'host-browser-unified',
        tabOrder: ['host-browser-unified']
      })
    ])
    expect(patch.activeGroupIdByWorktree?.[WT]).toBe(visibleGroupId)
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('reuses a local browser workspace that already points at the host page', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'about:blank',
      title: 'New Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: 'about:blank',
      title: 'New Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const unifiedTab: Tab = {
      id: 'local-browser-unified',
      entityId: workspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: 'New Tab',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.browserTabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.browserTabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: workspace.id,
      activePageId: page.id,
      url: 'https://example.com/',
      title: 'Example Domain'
    })
    expect(patch.browserPagesByWorkspace?.[workspace.id]).toMatchObject([
      {
        id: page.id,
        workspaceId: workspace.id,
        url: 'https://example.com/',
        title: 'Example Domain'
      }
    ])
    expect(patch.remoteBrowserPageHandlesByPageId?.[page.id]).toEqual({
      environmentId: ENV,
      remotePageId: 'host-browser-page'
    })
    expect(patch.unifiedTabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual([
      'local-browser-unified'
    ])
    expect(
      resolveHostSessionTabIdForWebSessionTab(makeState(), {
        environmentId: ENV,
        worktreeId: WT,
        tabId: 'local-browser-unified'
      })
    ).toBe('host-browser-unified')
  })

  it('resolves a canonical agent tab before its confirming snapshot arrives', () => {
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-agent-tab',
      hostTabId: 'canonical-host-tab',
      hostTerminalHandle: 'term-canonical'
    })

    expect(
      resolveHostSessionTabIdForWebSessionTab(makeState(), {
        environmentId: ENV,
        worktreeId: WT,
        tabId: 'provisional-agent-tab'
      })
    ).toBe('canonical-host-tab')
  })

  it('removes mirrored browser tabs when the host closes the page', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: workspace.url,
      title: workspace.title,
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: workspace.createdAt
    }
    const unifiedTab: Tab = {
      id: 'local-browser-unified',
      entityId: workspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: workspace.title,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: workspace.createdAt,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeBrowserTabId: workspace.id,
        activeBrowserTabIdByWorktree: { [WT]: workspace.id },
        activeTabType: 'browser',
        activeTabTypeByWorktree: { [WT]: 'browser' },
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.browserTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.browserPagesByWorkspace?.[workspace.id]).toBeUndefined()
    expect(patch.remoteBrowserPageHandlesByPageId?.[page.id]).toBeUndefined()
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeBrowserTabId).toBeNull()
    expect(patch.activeBrowserTabIdByWorktree?.[WT]).toBeNull()
    expect(patch.activeTabType).toBe('terminal')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('hydrates active host markdown tabs as remote editor tabs', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: true,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'draft:1',
            color: '#16a34a',
            isPinned: true
          }
        ],
        { activeTabId: 'host-readme-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const terminalId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.openFiles).toMatchObject([
      {
        id: '/repo/README.md',
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: WT,
        language: 'markdown',
        isDirty: true,
        runtimeEnvironmentId: ENV,
        mode: 'edit'
      }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'host-readme-unified',
          entityId: '/repo/README.md',
          contentType: 'editor',
          label: 'README.md',
          color: '#16a34a',
          isPinned: true
        })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      activeTabId: 'host-readme-unified',
      tabOrder: [terminalId, 'host-readme-unified']
    })
    expect(patch.activeFileId).toBe('/repo/README.md')
    expect(patch.activeFileIdByWorktree?.[WT]).toBe('/repo/README.md')
    expect(patch.activeTabType).toBe('editor')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('editor')
  })

  it('applies host-cleared browser and editor tab props over existing mirrored state', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const readmePath = pathPosix.join('/repo', 'README.md')
    const file: OpenFile = {
      id: readmePath,
      filePath: readmePath,
      relativePath: 'README.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit'
    }
    const existingTabs: Tab[] = [
      {
        id: 'local-browser-unified',
        entityId: workspace.id,
        groupId: 'host-group-1',
        worktreeId: WT,
        contentType: 'browser',
        label: 'Example Domain',
        customLabel: null,
        color: '#3b82f6',
        sortOrder: 0,
        createdAt: NOW - 10,
        isPreview: false,
        isPinned: true
      },
      {
        id: 'host-readme-unified',
        entityId: file.id,
        groupId: 'host-group-1',
        worktreeId: WT,
        contentType: 'editor',
        label: 'README.md',
        customLabel: null,
        color: '#16a34a',
        sortOrder: 1,
        createdAt: NOW - 9,
        isPreview: false,
        isPinned: true
      }
    ]

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        browserCertificateFailuresByPageId: {
          [page.id]: {
            challengeId: 'stale-challenge',
            browserPageId: 'host-browser-page',
            errorCode: -202,
            error: 'ERR_CERT_AUTHORITY_INVALID',
            origin: 'https://localhost:3443',
            displayHost: 'localhost:3443',
            canProceed: true,
            observedAt: 100
          }
        },
        openFiles: [file],
        unifiedTabsByWorktree: { [WT]: existingTabs }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            color: null,
            isPinned: false,
            isActive: false
          },
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: readmePath,
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: readmePath,
            sourceFilePath: readmePath,
            sourceRelativePath: 'README.md',
            documentVersion: `file:${readmePath}`,
            color: null,
            isPinned: false
          }
        ],
        { activeTabId: 'host-readme-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-browser-unified',
          color: null,
          isPinned: false
        }),
        expect.objectContaining({
          id: 'host-readme-unified',
          color: null,
          isPinned: false
        })
      ])
    )
    // Why: older runtimes omit this transient field. Omission must clear an
    // earlier challenge instead of leaving an unsafe action wired to stale RPC input.
    expect(patch.browserCertificateFailuresByPageId).toEqual({})
  })

  it('uses local markdown preview file ids while preserving the host unified tab id', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'markdown',
            id: 'host-preview-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'markdown-preview',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        { activeTabId: 'host-preview-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.openFiles).toMatchObject([
      {
        id: 'markdown-preview::/repo/README.md',
        filePath: '/repo/README.md',
        markdownPreviewSourceFileId: '/repo/README.md',
        mode: 'markdown-preview'
      }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]).toMatchObject([
      {
        id: 'host-preview-unified',
        entityId: 'markdown-preview::/repo/README.md',
        contentType: 'editor'
      }
    ])
    expect(patch.activeFileId).toBe('markdown-preview::/repo/README.md')
  })

  it('removes mirrored editor tabs when the host closes the file', () => {
    const hydratedPatch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        { activeTabId: 'host-readme-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    const hydratedState = { ...makeState(), ...hydratedPatch } as WebSessionTabsSyncState

    expect(hydratedState.openFiles[0]).toMatchObject({
      id: '/repo/README.md',
      mirroredFromRuntimeSession: true
    })
    expect(hydratedState.unifiedTabsByWorktree[WT]?.[0]).toMatchObject({
      id: 'host-readme-unified',
      entityId: '/repo/README.md'
    })

    const patch = applyWebSessionTabsSnapshot(
      hydratedState,
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.openFiles).toEqual([])
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeFileId).toBeNull()
    expect(patch.activeFileIdByWorktree?.[WT]).toBeNull()
    expect(patch.activeTabType).toBe('terminal')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('keeps locally opened editor tabs when the host snapshot omits them', () => {
    // Why: web file clicks open tabs locally with no host counterpart. A host
    // snapshot that does not list the file must not cull the user's own tab.
    const openFile: OpenFile = {
      id: '/repo/local-notes.md',
      filePath: '/repo/local-notes.md',
      relativePath: 'local-notes.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit'
    }
    const unifiedTab: Tab = {
      id: 'local-notes-unified',
      entityId: openFile.id,
      groupId: 'local-group',
      worktreeId: WT,
      contentType: 'editor',
      label: 'local-notes.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeFileId: openFile.id,
        activeFileIdByWorktree: { [WT]: openFile.id },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        openFiles: [openFile],
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'local-group',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    // The locally opened file and its tab survive the host snapshot sync. Nothing
    // is culled, so the sync leaves editor ownership and selection state alone.
    expect(patch.openFiles).toBeUndefined()
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeFileId).toBeUndefined()
    expect(patch.activeFileIdByWorktree).toBeUndefined()
    expect(patch.activeTabType).toBeUndefined()
    expect(patch.activeTabTypeByWorktree).toBeUndefined()
  })

  it('mirrors pending terminal handles without attaching a stale PTY', () => {
    const state = makeState()
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'pending shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).toBeTruthy()
    expect(patch.tabsByWorktree?.[WT]).toMatchObject([
      {
        id: mirroredId,
        ptyId: null,
        title: 'pending shell',
        worktreeId: WT
      }
    ])
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toBeUndefined()
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      ptyIdsByLeafId: {}
    })
    expect(patch.activeTabId).toBe(mirroredId)
  })

  it('does not attach a ready sibling PTY to an active pending split leaf', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'ready shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'pending shell',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).toBeTruthy()
    expect(patch.tabsByWorktree?.[WT]).toMatchObject([
      {
        id: mirroredId,
        ptyId: null,
        title: 'pending shell',
        worktreeId: WT
      }
    ])
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toEqual(['remote:web-env-1@@terminal-1'])
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      activeLeafId: SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1'
      }
    })
    expect(patch.activeTabId).toBe(mirroredId)
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(mirroredId)
  })
})
