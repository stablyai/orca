import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldSyncAllRuntimeSessionTabs,
  shouldApplyWebSessionTabsSnapshot,
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs
} from './web-session-tabs-sync/tracking-decisions'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  WT,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap,
  isWebRuntimeInitialTerminalBootstrapInFlight,
  markWebRuntimeInitialTerminalBootstrapAwaitingMirror,
  releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame
} from './web-runtime-initial-terminal-bootstrap'

const OTHER_ENV = 'web-env-2'
import {
  clearWebSessionTabsTrackingForWorktree,
  clearWebSessionTabsTrackingForEnvironment
} from './web-session-tabs-sync/tracking-lifecycle'

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
        localTerminalCount: 0,
        hasPersistedTerminalState: false,
        firstHostAnswer: false
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
        localTerminalCount: 1,
        hasPersistedTerminalState: true,
        firstHostAnswer: false
      })
    ).toBe(false)
  })

  // Explicit empty rows mean user-emptied, not never initialized; deleting them reseeded on every focus (STA-6173).
  it('does not bootstrap a terminal when an explicit empty row records the closed last terminal', () => {
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
        localTerminalCount: 0,
        hasPersistedTerminalState: true,
        firstHostAnswer: false
      })
    ).toBe(false)
  })

  it('bootstraps a terminal for a workspace that has no terminal row at all', () => {
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
        localTerminalCount: 0,
        hasPersistedTerminalState: false,
        firstHostAnswer: false
      })
    ).toBe(true)
  })

  // Unpublished/v0 means ask later, not zero terminals; seeding can duplicate panes a restarting host will republish.
  it('does not bootstrap on a synthesized unpublished frame with no terminal row', () => {
    const unpublished = makeSnapshot([], {
      publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
      snapshotVersion: 0,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...unpublished },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: false,
        firstHostAnswer: false
      })
    ).toBe(false)
  })

  // A paired client sees both frames through its navigation projection: the host still starting,
  // and the host's real answer for a worktree it has no tabs for.
  it('waits out a still-starting host but bootstraps on its real empty answer for a paired client', () => {
    const bootstrapOn = (publicationEpoch: string): boolean =>
      shouldBootstrapInitialWebRuntimeTerminal({
        event: {
          type: 'snapshot',
          ...makeSnapshot([], {
            publicationEpoch,
            snapshotVersion: 0,
            activeGroupId: null,
            activeTabId: null,
            activeTabType: null
          })
        },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: false,
        firstHostAnswer: false
      })

    expect(bootstrapOn('none:client-navigation')).toBe(false)
    expect(bootstrapOn('empty:3:client-navigation')).toBe(true)
  })

  // Teardown releases shared claims whose RPCs never settled or reconnect bootstrap stays suppressed.
  it('releases the in-flight bootstrap latch when worktree tracking is cleared', () => {
    expect(beginWebRuntimeInitialTerminalBootstrap(ENV, WT)).toBe(true)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT)).toBe(true)

    clearWebSessionTabsTrackingForWorktree(ENV, WT)

    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT)).toBe(false)
    expect(beginWebRuntimeInitialTerminalBootstrap(ENV, WT)).toBe(true)
  })

  it('releases the torn-down environment latch but preserves a sibling environment mid-create', () => {
    // Per-environment keys prevent ENV teardown releasing OTHER_ENV’s same-worktree pending create (STA-6173).
    expect(beginWebRuntimeInitialTerminalBootstrap(ENV, WT)).toBe(true)
    expect(beginWebRuntimeInitialTerminalBootstrap(OTHER_ENV, WT)).toBe(true)

    clearWebSessionTabsTrackingForEnvironment(ENV)

    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT)).toBe(false)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(OTHER_ENV, WT)).toBe(true)

    // Fresh closure flag is false; only the sibling latch prevents a duplicate create.
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })
    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedInitialTerminal: isWebRuntimeInitialTerminalBootstrapInFlight(OTHER_ENV, WT),
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: false,
        firstHostAnswer: false
      })
    ).toBe(false)
  })

  // Mirror frames release only resolved creates; releasing pending claims reopens the closure-reinstall race.
  it('releases an awaiting-mirror bootstrap on a mirror frame but never a pending create', () => {
    expect(beginWebRuntimeInitialTerminalBootstrap(ENV, WT)).toBe(true)
    releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(ENV, WT)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT)).toBe(true)

    markWebRuntimeInitialTerminalBootstrapAwaitingMirror(ENV, WT)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT)).toBe(true)
    releaseWebRuntimeInitialTerminalBootstrapOnMirrorFrame(ENV, WT)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT)).toBe(false)
  })

  it('does not park a bootstrap that was never claimed', () => {
    markWebRuntimeInitialTerminalBootstrapAwaitingMirror(ENV, WT)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT)).toBe(false)
  })

  // Workspace-switch effect reinstall must not seed again while the earlier closure’s create is unmirrored (STA-6173).
  it('declines a second bootstrap while one is already in flight for the worktree', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })
    const decide = (): boolean =>
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        // Only the shared latch survives a fresh closure’s false local flag.
        requestedInitialTerminal: isWebRuntimeInitialTerminalBootstrapInFlight(ENV, WT),
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: false,
        firstHostAnswer: false
      })

    expect(decide()).toBe(true)
    expect(beginWebRuntimeInitialTerminalBootstrap(ENV, WT)).toBe(true)
    expect(beginWebRuntimeInitialTerminalBootstrap(ENV, WT)).toBe(false)
    expect(decide()).toBe(false)

    endWebRuntimeInitialTerminalBootstrap(ENV, WT)
    expect(decide()).toBe(true)
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
