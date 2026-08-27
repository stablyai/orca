import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldSyncAllRuntimeSessionTabs,
  shouldApplyWebSessionTabsSnapshot,
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs
} from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  WT,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

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
})
