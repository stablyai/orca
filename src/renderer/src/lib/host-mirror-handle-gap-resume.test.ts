import path from 'node:path'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import {
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from '@/runtime/web-session-tabs-sync-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { makeCreatedAgentWorktree } from '@/lib/worktree-activation-created-agent.test-fixture'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  markHostSessionMirrorHydrated,
  resetHostSessionMirrorHydrationForTests
} from '@/runtime/host-session-mirror-hydration'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import type { RuntimeEnvironmentStatus } from '@/store/slices/runtime-status-types'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countParkedHostMirrorHandleGapPanesForTests,
  hasHostMirrorHandleWaitExpired,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'
import { makeTerminalTab } from '../store/slices/worktrees-slice-test-fixtures'

// Published rows without handles are unverifiable, never exited (ssh-execution-boundary.md). Assert the ORIGINAL deadline: accidental release/re-park looks identical but silently restarts its budget.

const initialAppStoreState = useAppStore.getState()

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WEB_TAB_ID = 'web-terminal-host-tab-1'
const SECOND_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const SIBLING_LEAF_ID = '44444444-4444-4444-8444-444444444444'
const SECOND_TAB_ID = 'web-terminal-host-tab-2'
const RUNTIME_ENV_ID = 'env-handle-gap'

function makeRuntimeOwnedWorktree(): ReturnType<typeof makeCreatedAgentWorktree> {
  return {
    ...makeCreatedAgentWorktree(),
    createdWithAgent: undefined,
    hostId: `runtime:${encodeURIComponent(RUNTIME_ENV_ID)}`
  }
}

function seedMirroredWorkspace(worktree: ReturnType<typeof makeCreatedAgentWorktree>): void {
  const state: Partial<AppState> = {
    repos: [
      {
        id: 'repo-1',
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [worktree] },
    activeRepoId: 'repo-1',
    activeWorktreeId: worktree.id,
    activeView: 'terminal',
    tabsByWorktree: {
      [worktree.id]: [makeTerminalTab({ id: WEB_TAB_ID, worktreeId: worktree.id, title: 'Claude' })]
    },
    terminalLayoutsByTabId: {
      [WEB_TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-handle-gap@@term_1' }
      }
    },
    // The gap itself: the row is published, its handle has not arrived.
    ptyIdsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {}
  }
  useAppStore.setState(state)
}

/** A cold split mirror whose sibling is ready before this leaf has ever held a binding. */
function seedSplitTabWithOnlySiblingReady(
  worktree: ReturnType<typeof makeCreatedAgentWorktree>
): void {
  seedMirroredWorkspace(worktree)
  useAppStore.setState({
    terminalLayoutsByTabId: {
      [WEB_TAB_ID]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
        },
        activeLeafId: SIBLING_LEAF_ID,
        expandedLeafId: null,
        // Only the ready sibling is bound; the record's leaf has never held a handle.
        ptyIdsByLeafId: { [SIBLING_LEAF_ID]: 'remote:env-handle-gap@@term_sibling' }
      }
    },
    ptyIdsByTabId: { [WEB_TAB_ID]: ['remote:env-handle-gap@@term_sibling'] }
  })
}

/** A second published mirrored row in the same environment, with its own leaf binding. */
function seedSecondMirroredPane(worktreeId: string): void {
  const before = useAppStore.getState()
  useAppStore.setState({
    tabsByWorktree: {
      [worktreeId]: [
        ...(before.tabsByWorktree[worktreeId] ?? []),
        makeTerminalTab({ id: SECOND_TAB_ID, worktreeId, title: 'Claude 2' })
      ]
    },
    terminalLayoutsByTabId: {
      ...before.terminalLayoutsByTabId,
      [SECOND_TAB_ID]: {
        root: { type: 'leaf', leafId: SECOND_LEAF_ID },
        activeLeafId: SECOND_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SECOND_LEAF_ID]: 'remote:env-handle-gap@@term_2' }
      }
    }
  })
}

/** The capture the reported flow produces: recorded mid-turn, so it is active work, not history. */
function seedActiveSleepingRecordFor(
  worktreeId: string,
  tabId: string,
  leafId: string,
  sessionId: string
): string {
  const paneKey = makePaneKey(tabId, leafId)
  useAppStore.setState({
    sleepingAgentSessionsByPaneKey: {
      ...useAppStore.getState().sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        tabId,
        worktreeId,
        agent: 'claude',
        providerSession: { key: 'session_id', id: sessionId },
        connectionId: null,
        prompt: '',
        state: 'working',
        capturedAt: 1000,
        updatedAt: 1000,
        terminalTitle: 'Claude',
        origin: 'live'
      }
    }
  })
  return paneKey
}

function seedActiveSleepingRecord(worktreeId: string): string {
  return seedActiveSleepingRecordFor(worktreeId, WEB_TAB_ID, LEAF_ID, 'handle-gap-session')
}

function setRuntimeEnvironmentStatusEntryForTests(
  environmentId: string,
  entry: RuntimeEnvironmentStatus
): void {
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map(useAppStore.getState().runtimeStatusByEnvironmentId).set(
      environmentId,
      entry
    )
  })
}

function setRuntimeEnvironmentDisconnectedForTests(environmentId: string): void {
  setRuntimeEnvironmentStatusEntryForTests(environmentId, { status: null, checkedAt: 0 })
}

function setRuntimeEnvironmentTransportDownForTests(environmentId: string): void {
  setRuntimeEnvironmentStatusEntryForTests(environmentId, {
    status: null,
    checkedAt: 1,
    snapshot: {
      environmentId,
      pairingRevision: 1,
      sequence: 2,
      checkedAt: 1,
      status: null,
      verification: 'unavailable',
      transport: 'disconnected'
    }
  })
}

// Same-runtime contact recovery changes hostContactEpoch without changing connection generation (#19647).
function setRuntimeEnvironmentReconnectedForTests(environmentId: string): void {
  setRuntimeEnvironmentStatusEntryForTests(environmentId, {
    status: {
      runtimeId: 'rt-1',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: 3,
      minCompatibleRuntimeClientVersion: 3
    },
    checkedAt: 2,
    hostContactEpoch: 1
  })
}

function clearRuntimeEnvironmentStatusEntryForTests(environmentId: string): void {
  const next = new Map(useAppStore.getState().runtimeStatusByEnvironmentId)
  next.delete(environmentId)
  useAppStore.setState({ runtimeStatusByEnvironmentId: next })
}

describe('resume across the mirror handle gap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAppStore.setState(initialAppStoreState, true)
    resetHostSessionMirrorHydrationForTests()
    resetHostMirrorHandleGapWaitsForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  afterEach(() => {
    // Cancel waits before store reset retracts rows and synchronously replays them.
    resetHostMirrorHandleGapWaitsForTests()
    useAppStore.setState(initialAppStoreState, true)
    resetHostSessionMirrorHydrationForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    vi.useRealTimers()
  })

  it('does not resume a published mirrored pane whose handle has not landed yet', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    const launched = resumeSleepingAgentSessionsForWorktree(worktree.id)

    const after = useAppStore.getState()
    expect(launched).toBe(0)
    expect(after.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(Object.keys(after.pendingStartupByTabId)).toHaveLength(0)
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
  })

  it('holds a slept binding retained through a pending snapshot without replacing it', () => {
    resetWebSessionTabsSyncTestState()
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    const snapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'Claude',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ],
      { worktree: worktree.id }
    )
    useAppStore.setState(
      applyWebSessionTabsSnapshot(useAppStore.getState(), snapshot, RUNTIME_ENV_ID, Date.now())
    )

    expect(
      useAppStore.getState().terminalLayoutsByTabId[WEB_TAB_ID]?.ptyIdsByLeafId?.[LEAF_ID]
    ).toBe('remote:env-handle-gap@@term_1')
    expect(useAppStore.getState().ptyIdsByTabId[WEB_TAB_ID] ?? []).toEqual([])
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS - 1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    vi.advanceTimersByTime(1)
    // The deadline ends the wait, but an unverifiable binding never authorizes a replacement.
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    resetWebSessionTabsSyncTestState()
  })

  it('does not resume a published host row without a PTY binding', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedActiveSleepingRecord(worktree.id)
    useAppStore.setState({
      terminalLayoutsByTabId: {
        [WEB_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
  })

  // Every release path must replay the sweep; a bounded wait with no replay strands recovery.

  it("releases when the pane's own handle lands and keeps the pane it now owns", () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    useAppStore.setState({ ptyIdsByTabId: { [WEB_TAB_ID]: ['remote:env-handle-gap@@term_1'] } })
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const after = useAppStore.getState()
    expect(after.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('does not resume a pending leaf merely because its sibling holds a handle', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedSplitTabWithOnlySiblingReady(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    // A sibling handle does not authorize a second writer for this leaf.
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)

    const after = useAppStore.getState()
    const resumeTabIds = (after.tabsByWorktree[worktree.id] ?? [])
      .map((tab) => tab.id)
      .filter((id) => id !== WEB_TAB_ID)
    expect(resumeTabIds).toHaveLength(0)
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it.each([true, false])('does not resume a retracted host row (parked=%s)', (parked) => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    if (parked) {
      expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    }

    useAppStore.setState({ tabsByWorktree: { [worktree.id]: [] } })
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS * 2)

    const after = useAppStore.getState()
    expect(after.tabsByWorktree[worktree.id]).toEqual([])
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases the handle wait at its deadline without authorizing a resume', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS - 1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    vi.advanceTimersByTime(1)

    const after = useAppStore.getState()
    const resumeTabIds = (after.tabsByWorktree[worktree.id] ?? [])
      .map((tab) => tab.id)
      .filter((id) => id !== WEB_TAB_ID)
    expect(resumeTabIds).toHaveLength(0)
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(hasHostMirrorHandleWaitExpired(RUNTIME_ENV_ID, WEB_TAB_ID)).toBe(true)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
  })

  it('keeps the original deadline when a second sweep re-parks the same pane', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)

    expect(hasHostMirrorHandleWaitExpired(RUNTIME_ENV_ID, WEB_TAB_ID)).toBe(true)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('re-arms the wait after a reconnect instead of inheriting the expired verdict', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)

    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    setRuntimeEnvironmentConnectionGenerationForTests(RUNTIME_ENV_ID, 1)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  // Reconnect during an armed wait must invalidate its pending deadline, independently of already-recorded verdicts.
  it('does not let a wait armed on the previous connection decide the new one', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS - 1)
    setRuntimeEnvironmentConnectionGenerationForTests(RUNTIME_ENV_ID, 1)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(1)

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  // Disconnect alone preserves generation; silence during an outage cannot prove remote exit or authorize a duplicate launch (#19735, ssh-execution-boundary.md).
  it('does not turn an outage into a verdict when the environment dropped mid-park', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    setRuntimeEnvironmentDisconnectedForTests(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const during = useAppStore.getState()
    expect(during.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(during.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect((during.tabsByWorktree[worktree.id] ?? []).map((tab) => tab.id)).toEqual([WEB_TAB_ID])
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)

    // Once contact returns, a full healthy budget must decide; retaining the old outage hold forever would strand recovery.
    clearRuntimeEnvironmentStatusEntryForTests(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const after = useAppStore.getState()
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  // Main reports transport outages as reconnecting too; guard both production outage states.
  it('does not turn a transport-down snapshot into a verdict either', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    setRuntimeEnvironmentTransportDownForTests(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const during = useAppStore.getState()
    expect(during.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(during.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
  })

  // An outage can start/end within one unchanged generation; contact epoch proves the budget lacked continuous host contact.
  it('does not record a verdict when contact was lost and regained inside the budget', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(1000)
    setRuntimeEnvironmentDisconnectedForTests(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS - 1001)
    setRuntimeEnvironmentReconnectedForTests(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(1)

    const during = useAppStore.getState()
    expect(during.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(during.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const after = useAppStore.getState()
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('releases only the pane whose handle landed when two panes share the environment', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedSecondMirroredPane(worktree.id)
    const firstPaneKey = seedActiveSleepingRecordFor(worktree.id, WEB_TAB_ID, LEAF_ID, 'session-1')
    const secondPaneKey = seedActiveSleepingRecordFor(
      worktree.id,
      SECOND_TAB_ID,
      SECOND_LEAF_ID,
      'session-2'
    )
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(2)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    useAppStore.setState({ ptyIdsByTabId: { [WEB_TAB_ID]: ['remote:env-handle-gap@@term_1'] } })

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    const after = useAppStore.getState()
    expect(after.sleepingAgentSessionsByPaneKey[firstPaneKey]).toBeDefined()
    expect(after.sleepingAgentSessionsByPaneKey[secondPaneKey]).toBeDefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)

    // Use the clock: a spurious release/re-park looks unchanged immediately but would restart this pane’s original deadline.
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[secondPaneKey]).toBeDefined()
  })

  it('does not release or reschedule a park because another environment published a handle', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    useAppStore.setState({
      ptyIdsByTabId: { 'web-terminal-other-env-tab': ['remote:env-other@@term_1'] }
    })

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(hasHostMirrorHandleWaitExpired(RUNTIME_ENV_ID, WEB_TAB_ID)).toBe(true)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
  })

  it('leaves no waiter or timer behind when the environment tears its rows down mid-park', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    // Teardown drops every row the environment owned.
    useAppStore.setState({ tabsByWorktree: {}, terminalLayoutsByTabId: {} })

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
