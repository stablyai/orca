// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { tagRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { getUnreadBadgeCount } from '@/lib/unread-badge-count'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { AppState } from '@/store/types'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

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
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { refreshWebRuntimeSessionTabsSnapshot } from './web-runtime-session'
import { registerWebSessionTabsNotificationLifecycleCases } from './web-session-tabs-notification-lifecycle-cases'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

const ENVIRONMENT_ID = 'env-a'
const ENVIRONMENT_B = 'env-b'
const RUNTIME_ID = 'runtime-a'
const RUNTIME_B = 'runtime-b'
const REVISION = 101
const NEXT_REVISION = 102
const REVISION_B = 202
const REPO_ID = 'repo-a'
const WORKTREE_ID = `${REPO_ID}::/worktree-a`
const OTHER_WORKTREE_ID = `${REPO_ID}::/other`
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(toWebTerminalSurfaceTabId(HOST_TAB_ID), LEAF_ID)
const NOW = 1_700_000_000_000
const MIRROR_KEY = `${ENVIRONMENT_ID}\u0001${RUNTIME_ID}\u00011\u0001${REVISION}`
const RECONNECTED_MIRROR_KEY = `${ENVIRONMENT_ID}\u0001${RUNTIME_ID}\u00012\u0001${REVISION}`
const REPAIRED_MIRROR_KEY = `${ENVIRONMENT_ID}\u0001${RUNTIME_ID}\u00011\u0001${NEXT_REVISION}`
const TWO_ENVIRONMENT_MIRROR_KEY = `${MIRROR_KEY}\u0000${ENVIRONMENT_B}\u0001${RUNTIME_B}\u00011\u0001${REVISION_B}`
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}
type TerminalState = 'working' | 'done' | 'blocked' | 'waiting'

const subscriptions: RuntimeSubscription[] = []
function listAllResponse(
  snapshots: readonly RuntimeMobileSessionTabsResult[]
): RuntimeRpcResponse<unknown> {
  return {
    id: 'list-all',
    ok: true,
    result: { snapshots },
    _meta: { runtimeId: RUNTIME_ID }
  }
}

const runtimeCall = vi.fn(async (): Promise<RuntimeRpcResponse<unknown>> => listAllResponse([]))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

function snapshot(
  snapshotVersion: number,
  state: TerminalState,
  stateStartedAt: number,
  updatedAt = stateStartedAt,
  turnCompletedAt?: number,
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
        ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {}),
        agentStatus: {
          state,
          prompt: 'review the PR',
          updatedAt,
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

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
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

function findEnvironmentSubscription(
  method: 'session.tabs.subscribeAll' | 'session.tabs.subscribe',
  environmentId: string,
  occurrence = 0
): RuntimeSubscription {
  const subscription = subscriptions.filter(
    ({ request }) => request.method === method && request.selector === environmentId
  )[occurrence]
  if (!subscription) {
    throw new Error(`Missing ${environmentId} ${method} subscription ${occurrence}`)
  }
  return subscription
}

async function publish(
  subscription: RuntimeSubscription,
  result: unknown,
  replayed = false
): Promise<void> {
  await act(async () => {
    const response = {
      id: 'subscription-event',
      ok: true as const,
      result,
      _meta: { runtimeId: RUNTIME_ID }
    }
    subscription.callbacks.onResponse(
      replayed ? tagRuntimeSubscriptionReplayResponse(response) : response
    )
    await settle()
  })
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

function badgeCount(): number {
  return getUnreadBadgeCount(useAppStore.getState())
}

async function parkAndReveal(): Promise<void> {
  act(() => {
    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
  })
  await act(settle)
}

describe('paired session-tab visibility-resume notifications', () => {
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

  registerWebSessionTabsNotificationLifecycleCases({
    mount: () => renderHook(() => useWebSessionTabsSync()),
    settle,
    findGlobalSubscription: (occurrence = 0) =>
      findSubscription('session.tabs.subscribeAll', occurrence),
    publish,
    snapshot,
    reconnect: async (hook, knownSnapshots = []) => {
      runtimeCall.mockResolvedValueOnce(listAllResponse(knownSnapshots))
      mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(RECONNECTED_MIRROR_KEY)
      hook.rerender()
      await act(settle)
    },
    refreshEager: async (eagerSnapshot) => {
      runtimeCall.mockResolvedValueOnce({
        id: 'eager-list',
        ok: true,
        result: eagerSnapshot,
        _meta: { runtimeId: RUNTIME_ID }
      })
      await act(async () => {
        await refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID)
        await settle()
      })
    },
    notificationDispatch: () => notificationDispatch,
    badgeCount,
    advanceNotificationTimers: () => vi.advanceTimersByTime(1_500),
    now: NOW
  })

  it.each(['done', 'blocked', 'waiting'] as const)(
    'alerts once for %s reached while the hidden mirror is parked',
    async (state) => {
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await publish(findSubscription('session.tabs.subscribeAll'), {
        type: 'updated',
        ...snapshot(1, 'working', NOW)
      })
      notificationDispatch.mockClear()

      await parkAndReveal()
      await publish(findSubscription('session.tabs.subscribeAll', 1), {
        type: 'snapshots',
        snapshots: [snapshot(2, state, NOW + 1_000)]
      })
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).toHaveBeenCalledTimes(1)
      expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenLastCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ attentionRequired: true })
        })
      )
      expect(badgeCount()).toBe(1)
      hook.unmount()
    }
  )

  it('keeps cold inventory silent', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [snapshot(1, 'done', NOW)]
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(0)
    hook.unmount()
  })

  it('keeps ordered listAll and subscription cold inventories silent', async () => {
    runtimeCall.mockResolvedValueOnce(listAllResponse([snapshot(1, 'working', NOW)]))
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [snapshot(2, 'done', NOW + 1_000)]
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(0)
    hook.unmount()
  })

  it.each(['done', 'blocked', 'waiting'] as const)(
    'arms later %s resumes after duplicate cold listAll and subscription inventories',
    async (state) => {
      runtimeCall.mockResolvedValueOnce(listAllResponse([snapshot(1, 'working', NOW)]))
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await publish(findSubscription('session.tabs.subscribeAll'), {
        type: 'snapshots',
        snapshots: [snapshot(1, 'working', NOW)]
      })
      notificationDispatch.mockClear()

      await parkAndReveal()
      await publish(findSubscription('session.tabs.subscribeAll', 1), {
        type: 'snapshots',
        snapshots: [snapshot(2, state, NOW + 1_000)]
      })
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).toHaveBeenCalledTimes(1)
      expect(badgeCount()).toBe(1)
      hook.unmount()
    }
  )

  it.each(['done', 'blocked', 'waiting'] as const)(
    'recovers %s after listAll succeeds and the initial subscription fails',
    async (state) => {
      runtimeCall.mockResolvedValueOnce(listAllResponse([snapshot(1, 'working', NOW)]))
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await act(async () => {
        findSubscription('session.tabs.subscribeAll').callbacks.onResponse({
          id: 'subscription-error',
          ok: false,
          error: { code: 'disconnected', message: 'subscription unavailable' },
          _meta: { runtimeId: RUNTIME_ID }
        })
        await settle()
      })
      notificationDispatch.mockClear()

      await parkAndReveal()
      await publish(findSubscription('session.tabs.subscribeAll', 1), {
        type: 'snapshots',
        snapshots: [snapshot(2, state, NOW + 1_000)]
      })
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).toHaveBeenCalledTimes(1)
      expect(badgeCount()).toBe(1)
      hook.unmount()
    }
  )

  it.each(['done', 'blocked'] as const)(
    'keeps cold %s inventory silent when first mounted hidden',
    async (state) => {
      setDocumentVisibility('hidden')
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)

      act(() => setDocumentVisibility('visible'))
      await act(settle)
      await publish(findSubscription('session.tabs.subscribeAll'), {
        type: 'snapshots',
        snapshots: [snapshot(1, state, NOW)]
      })
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).not.toHaveBeenCalled()
      expect(badgeCount()).toBe(0)
      hook.unmount()
    }
  )

  it.each(['done', 'blocked'] as const)(
    'keeps a cold active-worktree %s snapshot silent after first hidden mount',
    async (state) => {
      seedRemoteMirrorState(true)
      mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
      setDocumentVisibility('hidden')
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)

      act(() => setDocumentVisibility('visible'))
      await act(settle)
      await publish(findSubscription('session.tabs.subscribe'), {
        type: 'snapshot',
        ...snapshot(1, state, NOW)
      })
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).not.toHaveBeenCalled()
      expect(badgeCount()).toBe(0)
      hook.unmount()
    }
  )

  it('does not borrow another environment same-id worktree notification baseline', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findEnvironmentSubscription('session.tabs.subscribeAll', ENVIRONMENT_ID), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    const runtimeEnvironments = [
      { id: ENVIRONMENT_ID, createdAt: 100, pairingRevision: REVISION },
      { id: ENVIRONMENT_B, createdAt: 200, pairingRevision: REVISION_B }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState({
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENVIRONMENT_ID, { status: { runtimeId: RUNTIME_ID }, connectionGeneration: 1 }],
        [ENVIRONMENT_B, { status: { runtimeId: RUNTIME_B }, connectionGeneration: 1 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(TWO_ENVIRONMENT_MIRROR_KEY)
    hook.rerender()
    await act(settle)

    await publish(findEnvironmentSubscription('session.tabs.subscribeAll', ENVIRONMENT_B), {
      type: 'snapshots',
      snapshots: [snapshot(1, 'done', NOW + 1_000)]
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(0)
    hook.unmount()
  })

  it('does not borrow a replaced owner notification baseline', async () => {
    seedRemoteMirrorState(true)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    const runtimeEnvironments = [
      { id: ENVIRONMENT_ID, createdAt: 100, pairingRevision: NEXT_REVISION }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState({ runtimeEnvironments })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(REPAIRED_MIRROR_KEY)
    hook.rerender()
    await act(settle)
    await publish(findSubscription('session.tabs.subscribe', 2), {
      type: 'snapshot',
      ...snapshot(1, 'done', NOW + 1_000, NOW + 1_000, undefined, 'epoch-2')
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(0)
    hook.unmount()
  })

  it('forgets notification eligibility when a worktree is removed', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const global = findSubscription('session.tabs.subscribeAll')
    await publish(global, { type: 'updated', ...snapshot(1, 'working', NOW) })
    notificationDispatch.mockClear()

    await publish(global, {
      type: 'updated',
      worktree: WORKTREE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 2,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    await publish(global, {
      type: 'snapshots',
      snapshots: [snapshot(1, 'done', NOW + 1_000, NOW + 1_000, undefined, 'epoch-2')]
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(0)
    hook.unmount()
  })

  it('forgets active-stream eligibility after a visibility resume and removal', async () => {
    seedRemoteMirrorState(true)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    const active = findSubscription('session.tabs.subscribe', 1)
    await publish(active, {
      type: 'updated',
      worktree: WORKTREE_ID,
      publicationEpoch: 'epoch-1',
      snapshotVersion: 2,
      removed: true,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    await publish(active, {
      type: 'snapshot',
      ...snapshot(1, 'done', NOW + 1_000, NOW + 1_000, undefined, 'epoch-2')
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).not.toHaveBeenCalled()
    expect(badgeCount()).toBe(0)
    hook.unmount()
  })

  it.each(['done', 'blocked'] as const)(
    'keeps a metadata-only %s inventory refresh silent',
    async (state) => {
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      const global = findSubscription('session.tabs.subscribeAll')
      await publish(global, {
        type: 'snapshots',
        snapshots: [snapshot(1, state, NOW)]
      })
      await publish(global, {
        type: 'snapshots',
        snapshots: [snapshot(2, state, NOW, NOW + 5_000)]
      })
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).not.toHaveBeenCalled()
      expect(badgeCount()).toBe(0)
      hook.unmount()
    }
  )

  it('keeps same-turn reconnect replay and duplicate frames silent', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const global = findSubscription('session.tabs.subscribeAll')
    await publish(global, { type: 'updated', ...snapshot(1, 'working', NOW) })
    await publish(global, { type: 'updated', ...snapshot(2, 'done', NOW + 1_000) })
    vi.advanceTimersByTime(1_500)
    expect(notificationDispatch).toHaveBeenCalledTimes(1)

    await publish(
      global,
      { type: 'snapshots', snapshots: [snapshot(2, 'done', NOW + 1_000)] },
      true
    )
    await publish(global, {
      type: 'snapshots',
      snapshots: [snapshot(3, 'done', NOW + 1_000)]
    })
    vi.advanceTimersByTime(1_500)

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(badgeCount()).toBe(1)
    hook.unmount()
  })

  it('alerts for a new transition even when the first resume frame is replay-tagged', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    await publish(
      findSubscription('session.tabs.subscribeAll', 1),
      { type: 'snapshots', snapshots: [snapshot(2, 'blocked', NOW + 1_000)] },
      true
    )

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(badgeCount()).toBe(1)
    hook.unmount()
  })

  it.each(['done', 'blocked', 'waiting'] as const)(
    'alerts once when reconnect listAll wins with a new %s transition',
    async (state) => {
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      await publish(findSubscription('session.tabs.subscribeAll'), {
        type: 'updated',
        ...snapshot(1, 'working', NOW)
      })
      notificationDispatch.mockClear()

      runtimeCall.mockResolvedValueOnce(listAllResponse([snapshot(2, state, NOW + 1_000)]))
      mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(RECONNECTED_MIRROR_KEY)
      hook.rerender()
      await act(settle)
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).toHaveBeenCalledTimes(1)
      expect(badgeCount()).toBe(1)

      await publish(findSubscription('session.tabs.subscribeAll', 1), {
        type: 'snapshots',
        snapshots: [snapshot(2, state, NOW + 1_000)]
      })
      vi.advanceTimersByTime(1_500)

      expect(notificationDispatch).toHaveBeenCalledTimes(1)
      expect(badgeCount()).toBe(1)
      hook.unmount()
    }
  )

  it('alerts for a Claude stamped completion while the host row stays working', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [snapshot(2, 'working', NOW, NOW + 1_000, NOW + 1_000)]
    })

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(badgeCount()).toBe(1)
    hook.unmount()
  })

  it('alerts across a restarted host publication epoch without comparing clocks', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(10, 'working', NOW, NOW, undefined, 'epoch-1')
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [snapshot(1, 'blocked', NOW - 100_000, NOW, undefined, 'epoch-2')]
    })

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(badgeCount()).toBe(1)
    hook.unmount()
  })

  it('recovers a blocked prompt when the client and host clocks disagree', async () => {
    registerRendererOwnedAgentStatusPane(PANE_KEY, ENVIRONMENT_ID)
    markRendererOwnedAgentStatusWrite(PANE_KEY)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          state: 'working',
          prompt: 'review the PR',
          updatedAt: NOW + 100_000,
          stateStartedAt: NOW + 100_000,
          agentType: 'claude',
          paneKey: PANE_KEY,
          tabId: toWebTerminalSurfaceTabId(HOST_TAB_ID),
          worktreeId: WORKTREE_ID,
          stateHistory: []
        }
      }
    })
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [snapshot(2, 'blocked', NOW + 1_000, NOW + 200_000)]
    })

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(badgeCount()).toBe(1)
    hook.unmount()
  })

  it('alerts once when the active replay precedes the hidden transition and inventory', async () => {
    seedRemoteMirrorState(true)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    const active = findSubscription('session.tabs.subscribe', 1)
    await publish(active, { type: 'snapshot', ...snapshot(1, 'working', NOW) })
    await publish(active, { type: 'updated', ...snapshot(2, 'done', NOW + 1_000) })
    vi.advanceTimersByTime(1_500)
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [snapshot(2, 'done', NOW + 1_000)]
    })

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(mocks.observeAgentHookCompletionForNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ attentionRequired: true }) })
    )
    expect(badgeCount()).toBe(1)
    hook.unmount()
  })

  it('alerts once when the resumed inventory wins the active-stream race', async () => {
    seedRemoteMirrorState(true)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'updated',
      ...snapshot(1, 'working', NOW)
    })
    notificationDispatch.mockClear()

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [snapshot(2, 'done', NOW + 1_000)]
    })
    vi.advanceTimersByTime(1_500)
    await publish(findSubscription('session.tabs.subscribe', 1), {
      type: 'snapshot',
      ...snapshot(2, 'done', NOW + 1_000)
    })

    expect(notificationDispatch).toHaveBeenCalledTimes(1)
    expect(badgeCount()).toBe(1)
    hook.unmount()
  })
})
