// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
  type RuntimeMobileSessionTabsResult
} from '../../../shared/runtime-types'
import type { Worktree } from '../../../shared/worktree/types'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import type * as WebRuntimeTerminalCreationModule from './web-runtime-terminal-creation'
import type * as RuntimeRpcClientModule from './runtime-rpc-client'

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  ownerEnvironmentIdForWorkspace: vi.fn(),
  hostAnswersEmptyWorktree: vi.fn(async () => true),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn(),
  runtimeSessionMirrorEnvironmentKeys: vi.fn(() => ({
    environmentKey: null,
    resubscribeSignal: 0
  }))
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKey: mocks.runtimeSessionMirrorEnvironmentKey,
  useRuntimeSessionMirrorEnvironmentKeys: mocks.runtimeSessionMirrorEnvironmentKeys
}))

vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (state: unknown, workspaceId: string | null) =>
    workspaceId ? (mocks.ownerEnvironmentIdForWorkspace(state, workspaceId) ?? null) : null
}))

vi.mock('./runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClientModule>()
  return { ...actual, runtimeEnvironmentSupportsCapability: mocks.hostAnswersEmptyWorktree }
})

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

vi.mock('./web-runtime-terminal-creation', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalCreationModule>()
  return { ...actual, createWebRuntimeSessionTerminal: mocks.createTerminal }
})

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { useWebSessionTabsSync } from './web-session-tabs-sync/use-web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { resetWebRuntimeInitialTerminalBootstrapForTests } from './web-runtime-initial-terminal-bootstrap'
import { resetWebRuntimeWakeTerminalRespawnForTests } from './web-runtime-wake-terminal-respawn'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from '@/lib/web-runtime-worktree-terminal-after-wake'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from './paired-runtime-environment-test-fixture'

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

function makeWorktree(): Worktree {
  return {
    id: WORKTREE,
    repoId: 'repo-a',
    path: 'worktree-a',
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'worktree-a',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'local',
    runtimeOwnerEnvironmentId: ENV
  }
}

function hostTerminalSnapshot(snapshotVersion: number): RuntimeMobileSessionTabsResult {
  return {
    ...emptyActiveSnapshot(snapshotVersion),
    activeGroupId: 'host-tab-1',
    activeTabId: 'host-tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab-1::leaf-1',
        parentTabId: 'host-tab-1',
        leafId: 'leaf-1',
        title: 'Terminal 1',
        terminal: 'term_host',
        status: 'ready',
        isActive: true
      }
    ]
  }
}

function runtimeStatusMap(connectionGeneration: number): AppState['runtimeStatusByEnvironmentId'] {
  return new Map([[ENV, connectedRuntimeStatus('runtime-a', connectionGeneration)]])
}

function seedRemoteMirrorState(connectionGeneration: number): void {
  const runtimeEnvironments = [
    publicRuntimeEnvironment({ id: ENV, createdAt: 100, pairingRevision: REVISION })
  ]
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
    mocks.ownerEnvironmentIdForWorkspace.mockReset().mockReturnValue(ENV)
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

  // Effect reinstall during workspace switch must not rearm initial-terminal creation while its predecessor is pending (STA-6173).
  it('does not seed a second terminal when the effect re-runs before the first create settles', async () => {
    const pendingCreate = createDeferred<unknown>()
    mocks.createTerminal.mockReturnValue(pendingCreate.promise)

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    // Reinstall the active effect while create is pending, as on workspace switch.
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

  // Successful create may refresh an unconfirmed empty frame; retain latch without a mirrored row to avoid duplicate seeding.
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

  // RPC/network failures return failed, not throw; release the latch so later focus can retry.
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

  // Returned failure must leave both module and closure-local guards retryable, like throws; releasing only the shared latch suppresses this subscription forever.
  it('retries on the next frame of the same subscription after a create that returned failed', async () => {
    mocks.createTerminal.mockResolvedValue({ status: 'failed', message: 'host unreachable' })

    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    const subscription = findActiveSubscription(0)
    await publish(subscription, { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toBeUndefined()

    // Same closure must retry its next accepted empty frame after failure.
    await publish(subscription, { type: 'snapshot', ...emptyActiveSnapshot(2) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

  // Success without publication cannot hold forever: next accepted frame releases awaiting-mirror without seeding, then a later confirmed empty frame may retry.
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

describe('activating a host-owned workspace before the host has answered', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue({ status: 'created' })
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.ownerEnvironmentIdForWorkspace.mockReset().mockReturnValue(ENV)
    mocks.hostAnswersEmptyWorktree.mockReset().mockResolvedValue(true)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    resetWebRuntimeWakeTerminalRespawnForTests()
    seedRemoteMirrorState(1)
    useAppStore.setState({ worktreesByRepo: { 'repo-a': [makeWorktree()] } })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    resetWebRuntimeWakeTerminalRespawnForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    resetStaleDocumentVisibilityForTesting()
  })

  it('does not add a terminal to a workspace whose host terminals have not arrived yet', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    ensureWebRuntimeWorktreeTerminalAfterWake(WORKTREE, { runtimeEnvironmentId: ENV })
    await act(settle)
    await publish(findActiveSubscription(0), { type: 'snapshot', ...hostTerminalSnapshot(1) })

    expect(mocks.createTerminal).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('opens exactly one terminal once the host answers that the workspace is empty', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    ensureWebRuntimeWorktreeTerminalAfterWake(WORKTREE, { runtimeEnvironmentId: ENV })
    await act(settle)
    await publish(findActiveSubscription(0), { type: 'snapshot', ...emptyActiveSnapshot(1) })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('opens one terminal when the host first says "ask me later" and then answers empty', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    ensureWebRuntimeWorktreeTerminalAfterWake(WORKTREE, { runtimeEnvironmentId: ENV })
    await act(settle)
    const subscription = findActiveSubscription(0)
    await publish(subscription, {
      type: 'snapshot',
      ...emptyActiveSnapshot(0),
      publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
    })
    await publish(subscription, {
      type: 'updated',
      ...emptyActiveSnapshot(0),
      publicationEpoch: 'empty:1'
    })

    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('does not count an "ask me later" frame as zero terminals', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const subscription = findActiveSubscription(0)
    await publish(subscription, {
      type: 'snapshot',
      ...emptyActiveSnapshot(0),
      publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
    })

    ensureWebRuntimeWorktreeTerminalAfterWake(WORKTREE, { runtimeEnvironmentId: ENV })
    await act(settle)
    await publish(subscription, { type: 'updated', ...hostTerminalSnapshot(1) })

    expect(mocks.createTerminal).not.toHaveBeenCalled()
    hook.unmount()
  })
  it('opens one terminal on an older host whose "ask me later" is never followed by an answer', async () => {
    mocks.hostAnswersEmptyWorktree.mockResolvedValue(false)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findActiveSubscription(0), {
      type: 'snapshot',
      ...emptyActiveSnapshot(0),
      publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
    })

    ensureWebRuntimeWorktreeTerminalAfterWake(WORKTREE, { runtimeEnvironmentId: ENV })
    await act(settle)

    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    hook.unmount()
  })

  it('opens the first terminal of a workspace this client just created without waiting', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    ensureWebRuntimeWorktreeTerminalAfterWake(WORKTREE, {
      runtimeEnvironmentId: ENV,
      activate: false,
      unknownHostCountIsEmpty: true
    })
    await act(settle)

    expect(mocks.hostAnswersEmptyWorktree).not.toHaveBeenCalled()
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    hook.unmount()
  })
})
