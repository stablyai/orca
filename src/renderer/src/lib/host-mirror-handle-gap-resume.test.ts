import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { makeCreatedAgentWorktree } from '@/lib/worktree-activation-created-agent-test-state'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  markHostSessionMirrorHydrated,
  resetHostSessionMirrorHydrationForTests
} from '@/runtime/host-session-mirror-hydration'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countParkedHostMirrorHandleGapPanesForTests,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

// The window this pins: a paired runtime publishes a workspace's tab rows and its PTY handles on
// separate frames, so there is a frame where the row exists and `ptyIdsByTabId` is still empty.
// An empty handle map for a row the host is still publishing is `unverifiable`, never `exited`
// (docs/reference/ssh-execution-boundary.md), so nothing may be resumed off it.
//
// HOW TO ASSERT ON THIS MODULE, because the obvious way cannot fail. "Did the waiter release" is
// NOT an observable here: a waiter released for the wrong reason is immediately re-parked by the
// replayed sweep, so the store, the record and the parked count all read identically one tick
// later. A mutation that released every waiter on any tab's handle survived twelve tests written
// that way. What a spurious release actually costs is the deadline — the re-park starts a fresh
// budget — so the assertion has to advance the clock: park, advance part of the budget, do the
// thing, then advance to the ORIGINAL deadline and require the pane to decide on schedule.

const initialAppStoreState = useAppStore.getState()

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WEB_TAB_ID = 'web-terminal-host-tab-1'
const SECOND_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const SECOND_TAB_ID = 'web-terminal-host-tab-2'
const RUNTIME_ENV_ID = 'env-handle-gap'

function makeRuntimeOwnedWorktree(): ReturnType<typeof makeCreatedAgentWorktree> {
  return {
    ...makeCreatedAgentWorktree(),
    createdWithAgent: undefined,
    hostId: `runtime:${encodeURIComponent(RUNTIME_ENV_ID)}`
  }
}

/** A published mirrored row: tab, layout leaf, and the leaf's host PTY binding. */
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
      [worktree.id]: [{ id: WEB_TAB_ID, title: 'Claude', ptyId: null } as never]
    },
    terminalLayoutsByTabId: {
      [WEB_TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-handle-gap@@term_1' }
      } as never
    },
    // The gap itself: the row is published, its handle has not arrived.
    ptyIdsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {}
  }
  useAppStore.setState(state as AppState)
}

/** A second published mirrored row in the same environment, with its own leaf binding. */
function seedSecondMirroredPane(worktreeId: string): void {
  const before = useAppStore.getState()
  useAppStore.setState({
    tabsByWorktree: {
      [worktreeId]: [
        ...(before.tabsByWorktree[worktreeId] ?? []),
        { id: SECOND_TAB_ID, title: 'Claude 2', ptyId: null } as never
      ]
    },
    terminalLayoutsByTabId: {
      ...before.terminalLayoutsByTabId,
      [SECOND_TAB_ID]: {
        root: { type: 'leaf', leafId: SECOND_LEAF_ID },
        activeLeafId: SECOND_LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SECOND_LEAF_ID]: 'remote:env-handle-gap@@term_2' }
      } as never
    }
  } as never)
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
  } as never)
  return paneKey
}

function seedActiveSleepingRecord(worktreeId: string): string {
  return seedActiveSleepingRecordFor(worktreeId, WEB_TAB_ID, LEAF_ID, 'handle-gap-session')
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
    // Why first: the store reset below retracts every row, which would replay a still-parked wait.
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
    // The rows have arrived; only the handles are outstanding.
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    const launched = resumeSleepingAgentSessionsForWorktree(worktree.id)

    const after = useAppStore.getState()
    expect(launched).toBe(0)
    expect(after.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(Object.keys(after.pendingStartupByTabId)).toHaveLength(0)
    // The record survives: the next frame carries the handle and decides for real.
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    // And something is armed to decide it — a hold with nothing armed is the defect, not the fix.
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
  })

  it('still resumes once the host has published the row without any live handle', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedActiveSleepingRecord(worktree.id)
    useAppStore.setState({ ptyIdsByTabId: { [WEB_TAB_ID]: ['remote:env-handle-gap@@other'] } })
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(1)
  })

  // The three exits of the per-pane park. A park with no bounded release is the
  // latch-that-never-releases defect, so each one must replay the sweep.

  it("releases when the pane's own handle lands and keeps the pane it now owns", () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    useAppStore.setState({ ptyIdsByTabId: { [WEB_TAB_ID]: ['remote:env-handle-gap@@term_1'] } })
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    // The released waiter must not fire again at the deadline.
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const after = useAppStore.getState()
    expect(after.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  it('releases when a handle lands for the tab and resumes if it belongs to another pane', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    useAppStore.setState({ ptyIdsByTabId: { [WEB_TAB_ID]: ['remote:env-handle-gap@@other'] } })

    const after = useAppStore.getState()
    const resumeTabIds = (after.tabsByWorktree[worktree.id] ?? [])
      .map((tab) => tab.id)
      .filter((id) => id !== WEB_TAB_ID)
    expect(resumeTabIds).toHaveLength(1)
    expect(after.automaticAgentResumeClaimsByTabId[resumeTabIds[0]!]?.providerSession).toEqual({
      key: 'session_id',
      id: 'handle-gap-session'
    })
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  it('releases when the host retracts the row and resumes into a fresh tab', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    useAppStore.setState({ tabsByWorktree: { [worktree.id]: [] } })

    const after = useAppStore.getState()
    const tabs = after.tabsByWorktree[worktree.id] ?? []
    expect(tabs).toHaveLength(1)
    expect(after.automaticAgentResumeClaimsByTabId[tabs[0]!.id]?.providerSession).toEqual({
      key: 'session_id',
      id: 'handle-gap-session'
    })
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  it('releases at the deadline and resumes rather than holding the pane forever', () => {
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
    expect(resumeTabIds).toHaveLength(1)
    expect(after.automaticAgentResumeClaimsByTabId[resumeTabIds[0]!]?.providerSession).toEqual({
      key: 'session_id',
      id: 'handle-gap-session'
    })
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  it('keeps the original deadline when a second sweep re-parks the same pane', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    // A re-activation mid-wait must not push the decision out another full budget.
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(1)
  })

  it('re-arms the wait after a reconnect instead of inheriting the expired verdict', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(1)

    // A host restart: the same row, a new connection, its handle unknown again.
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    setRuntimeEnvironmentConnectionGenerationForTests(RUNTIME_ENV_ID, 1)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
  })

  // Why this is not the test above: there the wait had already expired before the reconnect, so
  // the stale verdict was a map entry. Here the wait is still armed when the generation moves, and
  // its deadline then fires on a connection that has had no chance at all to publish the handle.
  it('does not let a wait armed on the previous connection decide the new one', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    // The host reconnects one millisecond before the wait's own deadline.
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS - 1)
    setRuntimeEnvironmentConnectionGenerationForTests(RUNTIME_ENV_ID, 1)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(1)

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    // Re-armed, not held: the new connection gets its own budget and then decides.
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(1)
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

    // The first pane owns its live PTY; the second is still undecided, not resumed.
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    const after = useAppStore.getState()
    expect(after.sleepingAgentSessionsByPaneKey[firstPaneKey]).toBeDefined()
    expect(after.sleepingAgentSessionsByPaneKey[secondPaneKey]).toBeDefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(0)

    // Why the clock matters: releasing the second pane here and letting the replay re-park it
    // would look identical right now and silently restart its budget. Its own deadline still has
    // to land on the original schedule.
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[secondPaneKey]).toBeUndefined()
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
    // The unrelated handle must not have restarted this pane's budget.
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS / 2)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })

  it('leaves no waiter or timer behind when the environment tears its rows down mid-park', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)
    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(0)

    // Teardown drops every row the environment owned.
    useAppStore.setState({ tabsByWorktree: {}, terminalLayoutsByTabId: {} } as never)

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    // Nothing may still be scheduled against the torn-down environment.
    expect(vi.getTimerCount()).toBe(0)
  })
})
