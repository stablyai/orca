// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as WebRuntimeSessionModule from './web-runtime-session'

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey
}))

vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
  }
})

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

vi.mock('./web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  return { ...actual, createWebRuntimeSessionTerminal: mocks.createTerminal }
})

import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { resetWebRuntimeInitialTerminalBootstrapForTests } from './web-runtime-initial-terminal-bootstrap'

const ENV = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const REVISION = 101
const MIRROR_KEY = 'env-a::runtime-a::1'
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: RuntimeSubscription[] = []
const runtimeCall = vi.fn(async () => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-a' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function emptyActiveSnapshot(snapshotVersion: number): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function findActiveSubscription(occurrence: number): RuntimeSubscription {
  const matches = subscriptions.filter(({ request }) => request.method === 'session.tabs.subscribe')
  const subscription = matches[occurrence]
  if (!subscription) {
    throw new Error(`Missing active subscription ${occurrence}`)
  }
  return subscription
}

async function publish(subscription: RuntimeSubscription, result: unknown): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'subscription-event',
      ok: true as const,
      result,
      _meta: { runtimeId: 'runtime-a' }
    } as never)
    await settle()
  })
}

function runtimeStatusMap(connectionGeneration: number): AppState['runtimeStatusByEnvironmentId'] {
  return new Map([
    [ENV, { status: { runtimeId: 'runtime-a' }, connectionGeneration }]
  ]) as AppState['runtimeStatusByEnvironmentId']
}

function seedRemoteMirrorState(connectionGeneration: number): void {
  const runtimeEnvironments = [
    { id: ENV, createdAt: 100, pairingRevision: REVISION }
  ] as PublicKnownRuntimeEnvironment[]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: WORKTREE,
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: runtimeStatusMap(connectionGeneration)
    },
    true
  )
}

describe('useWebSessionTabsSync initial-terminal bootstrap across an effect re-run', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset()
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    seedRemoteMirrorState(1)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    resetStaleDocumentVisibilityForTesting()
  })

  // STA-6173, second defect. Returning to an emptied runtime-owned workspace re-runs the active
  // session-tabs effect (its environment / connection-generation / pairing / session-ready deps all
  // settle during a switch), installing a fresh subscription closure. The old per-closure
  // `requestedInitialTerminal` flag reset to false in the new closure, so a second empty frame
  // seeded a second terminal while the first create was still in flight. The module-scoped latch
  // outlives the closures, so exactly one create is issued.
  it('does not seed a second terminal when the effect re-runs before the first create settles', async () => {
    const pendingCreate = createDeferred<unknown>()
    mocks.createTerminal.mockReturnValue(pendingCreate.promise)

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    // Force the active effect to tear down and reinstall a fresh closure, exactly as switching back
    // to the workspace does, while the first create is still unresolved.
    act(() => {
      useAppStore.setState({ runtimeStatusByEnvironmentId: runtimeStatusMap(2) })
    })
    await act(settle)
    expect(
      subscriptions.filter(({ request }) => request.method === 'session.tabs.subscribe')
    ).toHaveLength(2)

    await publish(findActiveSubscription(1), { type: 'snapshot', ...emptyActiveSnapshot(2) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    pendingCreate.resolve(undefined)
    await act(settle)
    hook.unmount()
  })

  // CodeRabbit review: the create awaits its own snapshot refresh, but that refresh can resolve on
  // an empty, unconfirmed frame that leaves no `tabsByWorktree` row. Releasing the latch on settle
  // then would let the next effect re-run seed a second terminal even though the first create
  // succeeded. The latch is held until a row exists, so the re-run declines.
  it('does not seed again after a create that resolved without mirroring a row', async () => {
    // The create succeeds but writes no tabsByWorktree row (host has not published the tab yet).
    mocks.createTerminal.mockResolvedValue({ status: 'created' })

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toBeUndefined()

    // Re-run the active effect (workspace switch back) after the create already settled.
    act(() => {
      useAppStore.setState({ runtimeStatusByEnvironmentId: runtimeStatusMap(2) })
    })
    await act(settle)

    await publish(findActiveSubscription(1), { type: 'snapshot', ...emptyActiveSnapshot(2) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  // pullfrog review: `createWebRuntimeSessionTerminal` reports RPC and network failures as a
  // returned `{ status: 'failed' }`, never a throw. A latch released only in `catch` or once a row
  // exists therefore stays held after a failed create and suppresses every later auto-seed for the
  // worktree until teardown. A returned failure must release it so the next focus can retry.
  it('retries the bootstrap on the next focus after a create that returned failed', async () => {
    mocks.createTerminal.mockResolvedValue({ status: 'failed', message: 'host unreachable' })

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toBeUndefined()

    // The next focus installs a fresh closure; with the latch released, it may seed again.
    act(() => {
      useAppStore.setState({ runtimeStatusByEnvironmentId: runtimeStatusMap(2) })
    })
    await act(settle)

    await publish(findActiveSubscription(1), { type: 'snapshot', ...emptyActiveSnapshot(2) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

  // Third suppression path (review): the returned-failure release above frees the *module* latch,
  // but the caller sets its closure-local `requestedInitialTerminal` whenever the dispatch reports
  // it owned the create — including when that create returned `{ status: 'failed' }`. A thrown
  // failure never sets it and retries on the very next frame; since the create reports every RPC
  // and network failure as a return rather than a throw, the live path was the one that suppressed
  // the whole subscription. A failed create must leave the closure free to retry, exactly like a
  // thrown one.
  it('retries on the next frame of the same subscription after a create that returned failed', async () => {
    mocks.createTerminal.mockResolvedValue({ status: 'failed', message: 'host unreachable' })

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const subscription = findActiveSubscription(0)
    await publish(subscription, { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toBeUndefined()

    // Same closure, next accepted frame: nothing was created, so the workspace is still
    // never-initialized and the retry is the only thing that will ever give it a terminal.
    await publish(subscription, { type: 'snapshot', ...emptyActiveSnapshot(2) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

  // Readiness review: the inverse hazard of the test above. A create that succeeds but whose frame
  // never lands (host accepted, the mirror never got a row) must not hold the latch until environment
  // teardown. The frame right after the settle is the mirror's answer and may not seed (pre-mirror
  // window); the one after it decides on real state — no row, host affirms empty — and retries.
  it('retries after a successful create that never mirrored a row, once the mirror has answered', async () => {
    mocks.createTerminal.mockResolvedValue({ status: 'created' })

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toBeUndefined()

    // The mirror's answer: still empty. Releases the parked bootstrap; must not itself seed.
    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(2) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    // A later focus installs a fresh closure; with the latch released, its empty frame may retry.
    act(() => {
      useAppStore.setState({ runtimeStatusByEnvironmentId: runtimeStatusMap(2) })
    })
    await act(settle)
    await publish(findActiveSubscription(1), { type: 'snapshot', ...emptyActiveSnapshot(3) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(2)
    hook.unmount()
  })
})

// Adversarial pass 2 (concurrency), the fourth latch defect — this one inverts the sign of the
// three already found. Every exit the dispatch helper owns is guarded, but the latch is also
// released from OUTSIDE it: a pairing-revision change makes the global subscription run
// `clearWebSessionTabsTrackingForEnvironment`, which drops the environment's whole latch map
// regardless of phase. The same revision change is a dependency of the ACTIVE subscription effect,
// so it re-installs a closure whose `requestedInitialTerminal` is false at the same moment. A
// create still in flight therefore loses its claim and the very next empty frame owns a second
// create — STA-6173 restored by a re-pair. A `creating` claim is always released by its own
// dispatch (throw, returned failure, or resolve), so teardown never needs to release it early.
const MIRROR_KEY_PAIRED = 'env-a\u0001runtime-a\u00011\u0001101'
const MIRROR_KEY_REPAIRED = 'env-a\u0001runtime-a\u00011\u0001202'

describe('useWebSessionTabsSync initial-terminal latch across a mid-create re-pair', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset()
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY_PAIRED)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    seedRemoteMirrorState(1)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    resetStaleDocumentVisibilityForTesting()
  })

  it('does not seed a second terminal when a re-pair clears the environment mid-create', async () => {
    const pendingCreate = createDeferred<unknown>()
    mocks.createTerminal.mockReturnValue(pendingCreate.promise)

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    // Re-pair: the environment's pairing revision moves. The global effect clears the environment's
    // tracking and the active effect installs a fresh closure, both while the create is unresolved.
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(MIRROR_KEY_REPAIRED)
    const repairedEnvironments = [
      { id: ENV, createdAt: 100, pairingRevision: 202 }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(repairedEnvironments)
    act(() => {
      useAppStore.setState({ runtimeEnvironments: repairedEnvironments })
    })
    await act(settle)

    await publish(findActiveSubscription(1), {
      type: 'snapshot',
      ...emptyActiveSnapshot(1),
      publicationEpoch: 'epoch-2'
    })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    pendingCreate.resolve({ status: 'created' })
    await act(settle)
    hook.unmount()
  })
})
