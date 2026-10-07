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
import type { RuntimeEnvironmentStatus } from '@/store/slices/runtime-status-types'
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture carries the fields this suite drives; the cast only supplies the rest of the declared shape.
      [worktree.id]: [{ id: WEB_TAB_ID, title: 'Claude', ptyId: null } as never]
    },
    terminalLayoutsByTabId: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture carries the fields this suite drives; the cast only supplies the rest of the declared shape.
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
  useAppStore.setState(state as AppState)
}

/**
 * The first frame of a SPLIT mirrored tab whose sibling surface is already `ready` while the
 * record's own surface is still `pending-handle` and has never been bound.
 *
 * Why "never been bound" and not "went pending": `retainPendingTerminalBindings`
 * (web-session-tabs-sync/terminal-build.ts) carries a pending surface's PRIOR binding forward, so a
 * leaf that has ever held a handle keeps it across the gap and this shape cannot arise from one. It
 * needs a cold start or a re-pair — no existing layout to retain from.
 *
 * No wait is armed here for a separate reason: `ptyIdsByTabId[tab]` is non-empty, so the pane reads
 * decidable at the tab-granular gate before the per-pane wait is ever considered. That is the
 * residual, and it is decided on the first frame.
 *
 * And not "the tab published a handle no leaf is bound to": `ptyIdsByTabId[tab]` is built from the
 * very map written to `terminalLayoutsByTabId[tab].ptyIdsByLeafId`, so those two cannot disagree
 * about which PTY ids exist.
 */
function seedSplitTabWithOnlySiblingReady(
  worktree: ReturnType<typeof makeCreatedAgentWorktree>
): void {
  seedMirroredWorkspace(worktree)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
  useAppStore.setState({
    terminalLayoutsByTabId: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture carries the fields this suite drives; the cast only supplies the rest of the declared shape.
      [WEB_TAB_ID]: {
        root: {
          type: 'split',
          direction: 'row',
          first: { type: 'leaf', leafId: LEAF_ID },
          second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
        },
        activeLeafId: SIBLING_LEAF_ID,
        expandedLeafId: null,
        // Only the ready sibling is bound; the record's leaf has never held a handle.
        ptyIdsByLeafId: { [SIBLING_LEAF_ID]: 'remote:env-handle-gap@@term_sibling' }
      } as never
    },
    ptyIdsByTabId: { [WEB_TAB_ID]: ['remote:env-handle-gap@@term_sibling'] }
  } as never)
}

/** A second published mirrored row in the same environment, with its own leaf binding. */
function seedSecondMirroredPane(worktreeId: string): void {
  const before = useAppStore.getState()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
  useAppStore.setState({
    tabsByWorktree: {
      [worktreeId]: [
        ...(before.tabsByWorktree[worktreeId] ?? []),
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal names every field this suite reads; the cast only supplies the rest of the declared shape.
        { id: SECOND_TAB_ID, title: 'Claude 2', ptyId: null } as never
      ]
    },
    terminalLayoutsByTabId: {
      ...before.terminalLayoutsByTabId,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture carries the fields this suite drives; the cast only supplies the rest of the declared shape.
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
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

/** A recorded status entry whose runtime answered nothing: the shape a failed probe leaves behind. */
function setRuntimeEnvironmentDisconnectedForTests(environmentId: string): void {
  setRuntimeEnvironmentStatusEntryForTests(environmentId, { status: null, checkedAt: 0 })
}

/** The shape main's status channel publishes for a dropped transport; it reads `reconnecting`. */
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

/**
 * Contact regained on the SAME runtime: `runtime-status.ts` bumps `hostContactEpoch` and leaves the
 * connection generation alone (#19647).
 */
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

  // The counterweight to the park, and the reason the hydration short-circuit could not simply be
  // dropped: a pane with nothing outstanding must still resume. Here no leaf of the published row
  // binds a PTY this environment minted, so there is no handle on its way and no wait to arm —
  // parking would be the latch-that-never-releases defect, since mirror settlement has already run
  // and will not replay the sweep a second time.
  it('still resumes a published row no leaf of which binds this environment', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedMirroredWorkspace(worktree)
    seedActiveSleepingRecord(worktree.id)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
    useAppStore.setState({
      terminalLayoutsByTabId: {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture carries the fields this suite drives; the cast only supplies the rest of the declared shape.
        [WEB_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        } as never
      }
    } as never)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(1)
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
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

  // KNOWN RESIDUAL, pinned as current behaviour rather than as desired behaviour. The gate this
  // wait sits behind is tab-granular (`host-mirrored-pane-liveness.ts`: any published handle for
  // the tab makes the pane decidable), while everything below it is leaf-aware. A split tab whose
  // sibling surface is `ready` while this one is still `pending-handle` therefore reads decidable,
  // no wait is armed at all, and the sweep resumes a pane the host has not answered for — #19735's
  // own shape, narrowed to a split tab's first frame.
  //
  // It is not closable inside this module: such a leaf has NO binding, and the binding is what
  // names the pane in a verdict, so a leaf-keyed wait has nothing to key on. It needs the
  // per-surface `pending-handle` status the host publishes (runtime-mobile-session-projection.ts)
  // and the client consumes without retaining per leaf. Tracked separately; this case exists so
  // the residual cannot be mistaken for a covered one.
  it('resumes a pending leaf when a sibling leaf of the same tab holds the only handle', () => {
    const worktree = makeRuntimeOwnedWorktree()
    seedSplitTabWithOnlySiblingReady(worktree)
    const paneKey = seedActiveSleepingRecord(worktree.id)
    markHostSessionMirrorHydrated(RUNTIME_ENV_ID)

    expect(resumeSleepingAgentSessionsForWorktree(worktree.id)).toBe(1)
    // The residual in one assertion: nothing was ever parked for this pane.
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)

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

  // The journey: the network drops mid-turn on a paired runtime. Nothing is unpaired and no
  // reconnect has happened, so the connection generation has not moved — runtime-status.ts
  // advances it on the *reconnect*, under a new runtime id. The deadline therefore fires with a
  // generation that still matches, and its silence is about the outage, not about the host. A
  // verdict recorded there resumes the agent the host is still running (#19735 through the
  // disconnect door, docs/reference/ssh-execution-boundary.md).
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
    // Held, not abandoned: something is still armed to decide once contact returns.
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)

    // Contact returns and the host still publishes no handle for the pane. That silence IS
    // evidence, so the next full budget decides — a hold that outlives the outage would be the
    // latch-that-never-releases defect this module exists to avoid.
    clearRuntimeEnvironmentStatusEntryForTests(RUNTIME_ENV_ID)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const after = useAppStore.getState()
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(1)
  })

  // The same outage as the shape main actually publishes: a status snapshot with the transport
  // down, which the shared derivation reads as `reconnecting` rather than `disconnected`. Both
  // are "we could not ask"; a guard that honoured only one would miss the production path.
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

  // The outage begins AND ends inside one budget, on the same runtime. At the deadline contact is
  // back and the generation never moved, so the two guards above both pass — yet the pane had one
  // millisecond of contact in which to publish. `hostContactEpoch` is the record that an outage
  // happened in between; a wait that sees it move measured the outage, not the host.
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
    // Re-armed on the regained contact; the next full budget of real silence decides.
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
    vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)

    const after = useAppStore.getState()
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    expect(Object.keys(after.automaticAgentResumeClaimsByTabId)).toHaveLength(1)
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seeded slice names only the store fields this suite drives; the rest of AppState keeps its defaults.
    useAppStore.setState({ tabsByWorktree: {}, terminalLayoutsByTabId: {} } as never)

    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    // Nothing may still be scheduled against the torn-down environment.
    expect(vi.getTimerCount()).toBe(0)
  })
})
