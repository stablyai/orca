// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import { getUnreadBadgeCount } from '@/lib/unread-badge-count'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { AppState } from '@/store/types'

const mocks = vi.hoisted(() => ({
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
  observeAgentHookCompletionForNotification: vi.fn(),
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

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: mocks.observeAgentHookCompletionForNotification
}))

import { useAppStore } from '@/store'
import {
  createAgentCompletionCoordinator,
  resetAgentCompletionCoordinatorIdentitiesForTest
} from '@/components/terminal-pane/agent-completion-coordinator'
import { resetRendererOwnedAgentStatusPanesForTests } from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

const ENVIRONMENT_ID = 'env-a'
const RUNTIME_ID = 'runtime-a'
const REVISION = 101
const REPO_ID = 'repo-a'
const WORKTREE_ID = `${REPO_ID}::/worktree-a`
const OTHER_WORKTREE_ID = `${REPO_ID}::/other`
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
const NOW = 1_700_000_000_000
const MIRROR_KEY = `${ENVIRONMENT_ID}\u0001${RUNTIME_ID}\u00011\u0001${REVISION}`
const RECONNECTED_MIRROR_KEY = `${ENVIRONMENT_ID}\u0001${RUNTIME_ID}\u00012\u0001${REVISION}`
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const subscriptions: RuntimeSubscription[] = []
const runtimeCall = vi.fn(
  async (): Promise<RuntimeRpcResponse<unknown>> => ({
    id: 'list-all',
    ok: true,
    result: { snapshots: [] },
    _meta: { runtimeId: RUNTIME_ID }
  })
)
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

function createDeferred<T>(): Deferred<T> {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(
  snapshotVersion: number,
  state: 'working' | 'done' | 'waiting',
  stateStartedAt: number,
  publicationEpoch = 'epoch-1'
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: HOST_TAB_ID,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        title: 'Claude',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state,
          prompt: 'review the PR',
          updatedAt: stateStartedAt,
          stateStartedAt,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
          tabId: HOST_TAB_ID,
          worktreeId: WORKTREE_ID,
          stateHistory: []
        }
      }
    ]
  } as RuntimeMobileSessionTabsResult
}

function findSubscription(
  method: 'session.tabs.subscribeAll' | 'session.tabs.subscribe',
  occurrence = 0
): RuntimeSubscription {
  const subscription = subscriptions.filter(({ request }) => request.method === method)[occurrence]
  if (!subscription) {
    throw new Error(`Missing ${method} subscription ${occurrence}`)
  }
  return subscription
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function publish(subscription: RuntimeSubscription, result: unknown): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'subscription-event',
      ok: true,
      result,
      _meta: { runtimeId: RUNTIME_ID }
    })
    await settle()
  })
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function parkAndReveal(): Promise<void> {
  act(() => {
    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
  })
  await act(settle)
}

function seedRemoteMirrorState(activeRemoteWorktree = false): void {
  const runtimeEnvironments = [
    { id: ENVIRONMENT_ID, createdAt: 100, pairingRevision: REVISION }
  ] as PublicKnownRuntimeEnvironment[]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: activeRemoteWorktree ? WORKTREE_ID : OTHER_WORKTREE_ID,
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { runtimeId: RUNTIME_ID }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId'],
      worktreesByRepo: {
        [REPO_ID]: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: REPO_ID,
            path: '/worktree-a',
            runtimeOwnerEnvironmentId: ENVIRONMENT_ID
          }),
          makeWorktree({ id: OTHER_WORKTREE_ID, repoId: REPO_ID, path: '/other' })
        ]
      }
    },
    true
  )
}

function markUnread(): void {
  useAppStore.setState((state) => ({
    worktreesByRepo: {
      ...state.worktreesByRepo,
      [REPO_ID]: state.worktreesByRepo[REPO_ID].map((worktree) =>
        worktree.id === WORKTREE_ID ? { ...worktree, isUnread: true } : worktree
      )
    }
  }))
}

describe('paired session-tab notification receipt ordering', () => {
  let notificationDispatch: Mock<(kind: 'done' | 'attention') => void>
  let disposeCoordinator: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(null)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, value) => value)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    mocks.observeAgentHookCompletionForNotification.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    setDocumentVisibility('visible')
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
    seedRemoteMirrorState()
    notificationDispatch = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: PANE_KEY,
      statusLane: 'hook',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(),
      dispatchCompletion: () => {
        notificationDispatch('done')
        markUnread()
      },
      dispatchAttention: () => {
        notificationDispatch('attention')
        markUnread()
      },
      isLive: () => true
    })
    disposeCoordinator = () => coordinator.dispose()
    mocks.observeAgentHookCompletionForNotification.mockImplementation(({ payload, seedOnly }) => {
      if (seedOnly) {
        coordinator.seedHookStatus(payload)
      } else {
        coordinator.observeHookStatus(payload)
      }
    })
  })

  afterEach(() => {
    disposeCoordinator()
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetAgentCompletionCoordinatorIdentitiesForTest()
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
    setDocumentVisibility('visible')
    vi.useRealTimers()
  })

  it('arms an initial active snapshot before the next live transition', async () => {
    seedRemoteMirrorState(true)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const active = findSubscription('session.tabs.subscribe')

    await publish(active, { type: 'snapshot', ...snapshot(1, 'working', NOW) })
    notificationDispatch.mockClear()
    await publish(active, { type: 'updated', ...snapshot(2, 'done', NOW + 1_000) })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(1)
    hook.unmount()
  })

  it('delivers a live completion without waiting for slow terminal recovery', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const global = findSubscription('session.tabs.subscribeAll')
    const slowWorkingRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => slowWorkingRecovery.promise)

    await publish(global, { type: 'snapshots', snapshots: [snapshot(1, 'working', NOW)] })
    await publish(global, { type: 'updated', ...snapshot(2, 'done', NOW + 1_000) })
    vi.advanceTimersByTime(1_500)
    expect(notificationDispatch).toHaveBeenCalledTimes(1)

    await act(async () => {
      slowWorkingRecovery.resolve(snapshot(1, 'working', NOW))
      await settle()
      await settle()
    })
    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(1)
    hook.unmount()
  })

  it('keeps a failed cold recovery seeded and its later duplicate silent', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const global = findSubscription('session.tabs.subscribeAll')
    mocks.recoverSnapshot.mockResolvedValueOnce(null)

    await publish(global, {
      type: 'snapshots',
      snapshots: [snapshot(1, 'done', NOW)]
    })
    await publish(global, { type: 'updated', ...snapshot(2, 'done', NOW) })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(0)
    hook.unmount()
  })

  it('delivers a transition even when that frame terminal recovery failed', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const global = findSubscription('session.tabs.subscribeAll')
    await publish(global, { type: 'updated', ...snapshot(1, 'working', NOW) })
    mocks.recoverSnapshot.mockResolvedValueOnce(null)
    await publish(global, { type: 'updated', ...snapshot(2, 'done', NOW + 1_000) })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(1)
    hook.unmount()
  })

  it.each(['done', 'waiting'] as const)(
    'preserves the same-owner baseline through a status-null transport gap for %s',
    async (state) => {
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await publish(findSubscription('session.tabs.subscribeAll'), {
        type: 'updated',
        ...snapshot(1, 'working', NOW)
      })
      notificationDispatch.mockClear()

      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          [ENVIRONMENT_ID, { status: null, connectionGeneration: 1 }]
        ]) as AppState['runtimeStatusByEnvironmentId']
      })
      mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue('')
      hook.rerender()
      await act(settle)

      runtimeCall.mockResolvedValueOnce({
        id: 'list-all-after-offline-transition',
        ok: true,
        result: { snapshots: [snapshot(2, state, NOW + 1_000)] },
        _meta: { runtimeId: RUNTIME_ID }
      })
      useAppStore.setState({
        runtimeStatusByEnvironmentId: new Map([
          [ENVIRONMENT_ID, { status: { runtimeId: RUNTIME_ID }, connectionGeneration: 2 }]
        ]) as AppState['runtimeStatusByEnvironmentId']
      })
      mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(RECONNECTED_MIRROR_KEY)
      hook.rerender()
      await act(settle)
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).toHaveBeenCalledTimes(1)
      expect(getUnreadBadgeCount(useAppStore.getState())).toBe(1)
      hook.unmount()
    }
  )

  it('repairs an exact reconnect replay without dispatching it again', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const global = findSubscription('session.tabs.subscribeAll')
    await publish(global, { type: 'updated', ...snapshot(1, 'working', NOW) })
    await publish(global, { type: 'updated', ...snapshot(2, 'waiting', NOW + 1_000) })
    vi.advanceTimersByTime(1_500)
    notificationDispatch.mockClear()

    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: null, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId'],
      agentStatusByPaneKey: {}
    })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue('')
    hook.rerender()
    await act(settle)

    runtimeCall.mockResolvedValueOnce({
      id: 'same-version-list-all-replay',
      ok: true,
      result: { snapshots: [snapshot(2, 'waiting', NOW + 1_000)] },
      _meta: { runtimeId: RUNTIME_ID }
    })
    useAppStore.setState({
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { runtimeId: RUNTIME_ID }, connectionGeneration: 2 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(RECONNECTED_MIRROR_KEY)
    hook.rerender()
    await act(settle)
    vi.advanceTimersByTime(1_500)

    expect(useAppStore.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
      state: 'waiting'
    })
    expect(notificationDispatch).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('keeps newer inventory eligibility when older recovery finishes last', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const global = findSubscription('session.tabs.subscribeAll')
    await publish(global, { type: 'updated', ...snapshot(1, 'working', NOW) })
    notificationDispatch.mockClear()

    const olderRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    const unrelatedSnapshot = {
      ...snapshot(1, 'done', NOW),
      worktree: OTHER_WORKTREE_ID,
      tabs: []
    }
    mocks.recoverSnapshot.mockImplementationOnce(() => olderRecovery.promise)
    await publish(global, { type: 'snapshots', snapshots: [unrelatedSnapshot] })
    await publish(global, { type: 'snapshots', snapshots: [snapshot(2, 'working', NOW)] })

    await act(async () => {
      olderRecovery.resolve(unrelatedSnapshot)
      await settle()
      await settle()
    })
    await publish(global, { type: 'updated', ...snapshot(3, 'done', NOW + 1_000) })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(1)
    hook.unmount()
  })

  it('keeps a same-ID reappearance cold after authoritative absence', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    runtimeCall.mockResolvedValueOnce({
      id: 'empty-list-all-reconnect',
      ok: true,
      result: { snapshots: [] },
      _meta: { runtimeId: RUNTIME_ID }
    })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(RECONNECTED_MIRROR_KEY)
    hook.rerender()
    await act(settle)
    await act(async () => {
      findSubscription('session.tabs.subscribeAll', 1).callbacks.onResponse({
        id: 'failed-subscription',
        ok: false,
        error: { code: 'disconnected', message: 'subscription unavailable' },
        _meta: { runtimeId: RUNTIME_ID }
      })
      await settle()
    })

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribeAll', 2), {
      type: 'snapshots',
      snapshots: [snapshot(1, 'done', NOW + 1_000, 'epoch-2')]
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(getUnreadBadgeCount(useAppStore.getState())).toBe(0)
    hook.unmount()
  })

  it('closes recovered attention after unchanged active and global resume frames', async () => {
    seedRemoteMirrorState(true)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribe', 1), {
      type: 'snapshot',
      ...snapshot(1, 'working', NOW)
    })
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [snapshot(1, 'working', NOW)]
    })
    notificationDispatch.mockClear()
    mocks.observeAgentHookCompletionForNotification.mockClear()

    await publish(findSubscription('session.tabs.subscribe', 1), {
      type: 'updated',
      ...snapshot(2, 'done', NOW + 1_000)
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.not.objectContaining({ attentionRequired: true })
      })
    )
    hook.unmount()
  })

  it('preserves recovered attention when reconnect listAll wins the resume race', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    })
    runtimeCall.mockResolvedValueOnce({
      id: 'resume-list-all',
      ok: true,
      result: { snapshots: [snapshot(2, 'done', NOW + 1_000)] },
      _meta: { runtimeId: RUNTIME_ID }
    })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(RECONNECTED_MIRROR_KEY)
    hook.rerender()
    act(() => setDocumentVisibility('visible'))
    await act(settle)
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ attentionRequired: true })
      })
    )
    hook.unmount()
  })
})
