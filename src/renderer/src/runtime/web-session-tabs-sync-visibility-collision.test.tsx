// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
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
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import { subscribeAcceptedWebSessionTerminalHandle } from './web-session-terminal-handle-events'
import {
  _getWebSessionTabsRecoveryTrackingCountsForTest,
  _getWebSessionTabsTrackingCountsForTest,
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync,
  WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS
} from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WORKTREE = 'repo-a::worktree-a'
const REVISION_A = 101
const REVISION_B = 201
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const MIRROR_KEY = `${ENV_A}\u0001runtime-a\u00011\u0001${REVISION_A}\u0000${ENV_B}\u0001runtime-b\u00012\u0001${REVISION_B}`
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
const runtimeCall = vi.fn(async () => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-test' }
}))
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

function makeTerminalSnapshot(
  idSuffix: string,
  snapshotVersion = 1
): RuntimeMobileSessionTabsResult {
  const parentTabId = `host-tab${idSuffix}`
  const leafId = idSuffix === '-a' ? LEAF_A : LEAF_B
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: `host-group${idSuffix}`,
    activeTabId: `host-surface${idSuffix}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `host-surface${idSuffix}`,
        parentTabId,
        leafId,
        title: `Terminal ${idSuffix}`,
        status: 'ready',
        terminal: `terminal${idSuffix}`,
        isActive: true,
        agentStatus: {
          state: 'working',
          prompt: 'build',
          updatedAt: 100,
          stateStartedAt: 90,
          agentType: 'codex',
          paneKey: `${parentTabId}:${leafId}`,
          tabId: parentTabId,
          worktreeId: WORKTREE,
          stateHistory: []
        }
      }
    ]
  }
}

function makeEditorSnapshot(idSuffix: string): RuntimeMobileSessionTabsResult {
  const filePath = `/repo${idSuffix}/README.md`
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: `host-group${idSuffix}`,
    activeTabId: `host-editor${idSuffix}`,
    activeTabType: 'markdown',
    tabs: [
      {
        type: 'markdown',
        id: `host-editor${idSuffix}`,
        title: `README ${idSuffix}`,
        filePath,
        relativePath: 'README.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        isActive: true,
        sourceFileId: filePath,
        sourceFilePath: filePath,
        sourceRelativePath: 'README.md',
        documentVersion: `file:${filePath}`
      }
    ]
  }
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

async function settleGlobalMirrorResumeStarts(): Promise<void> {
  act(() => vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS))
  await act(settle)
}

function findGlobalSubscription(environmentId: string, occurrence = 0): RuntimeSubscription {
  const matches = subscriptions.filter(
    ({ request }) =>
      request.method === 'session.tabs.subscribeAll' && request.selector === environmentId
  )
  const subscription = matches[occurrence]
  if (!subscription) {
    throw new Error(`Missing global subscription ${occurrence} for ${environmentId}`)
  }
  return subscription
}

function findActiveSubscription(environmentId: string, occurrence = 0): RuntimeSubscription {
  const matches = subscriptions.filter(
    ({ request }) =>
      request.method === 'session.tabs.subscribe' && request.selector === environmentId
  )
  const subscription = matches[occurrence]
  if (!subscription) {
    throw new Error(`Missing active subscription ${occurrence} for ${environmentId}`)
  }
  return subscription
}

async function publish(subscription: RuntimeSubscription, result: unknown): Promise<void> {
  await act(async () => {
    subscription.callbacks.onResponse({
      id: 'subscription-event',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-test' }
    })
    await settle()
  })
}

function seedRemoteMirrorState(): void {
  const runtimeEnvironments = [
    { id: ENV_A, createdAt: 100, pairingRevision: REVISION_A },
    { id: ENV_B, createdAt: 200, pairingRevision: REVISION_B }
  ] as PublicKnownRuntimeEnvironment[]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: WORKTREE,
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENV_A, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }],
        [ENV_B, { status: { runtimeId: 'runtime-b' }, connectionGeneration: 2 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    },
    true
  )
}

describe('useWebSessionTabsSync visibility collision recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    setDocumentVisibility('visible')
    resetWebSessionTabsSnapshotFreshnessForTests()
    seedRemoteMirrorState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetStaleDocumentVisibilityForTesting()
    setDocumentVisibility('visible')
    vi.useRealTimers()
  })

  it('resumes the active host before lexicographically earlier global mirrors', async () => {
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReturnValue(ENV_B)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    const globalSubscriptionCount = (environmentId: string): number =>
      subscriptions.filter(
        ({ request }) =>
          request.method === 'session.tabs.subscribeAll' && request.selector === environmentId
      ).length
    expect(globalSubscriptionCount(ENV_B)).toBe(2)
    expect(globalSubscriptionCount(ENV_A)).toBe(1)

    act(() => vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS - 1))
    expect(globalSubscriptionCount(ENV_A)).toBe(1)
    act(() => vi.advanceTimersByTime(1))
    await act(settle)
    expect(globalSubscriptionCount(ENV_A)).toBe(2)
    hook.unmount()
  })

  it('replays a surviving terminal host after a later omitted-host tombstone', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-a')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()
    await publish(findGlobalSubscription(ENV_B, 1), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-b')]
    })
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'snapshots',
      snapshots: [],
      authoritative: true
    })

    const state = useAppStore.getState()
    const tabId = toWebTerminalSurfaceTabId('host-tab-b')
    const paneKey = makePaneKey(tabId, LEAF_B)
    expect(state.tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([tabId])
    expect(state.ptyIdsByTabId[tabId]).toEqual([toRemoteRuntimePtyId('terminal-b', ENV_B)])
    expect(state.terminalLayoutsByTabId[tabId]?.activeLeafId).toBe(LEAF_B)
    expect(state.unifiedTabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([tabId])
    expect(state.tabBarOrderByWorktree[WORKTREE]).toEqual([tabId])
    expect(state.activeTabIdByWorktree[WORKTREE]).toBe(tabId)
    expect(state.groupsByWorktree[WORKTREE]?.flatMap((group) => group.tabOrder)).toEqual([tabId])
    expect(state.agentStatusByPaneKey[paneKey]?.state).toBe('working')
    hook.unmount()
  })

  it('publishes terminal-handle evidence for an unchanged resume inventory', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeTerminalSnapshot('-a')
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })
    const tabsByWorktree = useAppStore.getState().tabsByWorktree
    const listener = vi.fn()
    const unsubscribe = subscribeAcceptedWebSessionTerminalHandle(
      { environmentId: ENV_A, worktreeId: WORKTREE, hostTabId: 'host-tab-a', leafId: LEAF_A },
      listener
    )
    mocks.recoverSnapshot.mockClear()

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'snapshots',
      snapshots: [snapshot]
    })

    expect(mocks.recoverSnapshot).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree).toBe(tabsByWorktree)
    expect(listener).toHaveBeenCalledWith({ surfacePresent: true, terminalHandle: 'terminal-a' })
    unsubscribe()
    hook.unmount()
  })

  it('replays a surviving editor host after a later omitted-host tombstone', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [makeEditorSnapshot('-a')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()
    await publish(findGlobalSubscription(ENV_B, 1), {
      type: 'snapshots',
      snapshots: [makeEditorSnapshot('-b')]
    })
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'snapshots',
      snapshots: [],
      authoritative: true
    })

    const state = useAppStore.getState()
    const fileId = '/repo-b/README.md'
    expect(
      state.openFiles
        .filter((file) => file.worktreeId === WORKTREE)
        .map((file) => [file.id, file.runtimeEnvironmentId])
    ).toEqual([[fileId, ENV_B]])
    expect(state.unifiedTabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual(['host-editor-b'])
    expect(state.tabBarOrderByWorktree[WORKTREE]).toEqual(['host-editor-b'])
    expect(state.activeFileIdByWorktree[WORKTREE]).toBe(fileId)
    expect(state.groupsByWorktree[WORKTREE]?.flatMap((group) => group.tabOrder)).toEqual([
      'host-editor-b'
    ])
    hook.unmount()
  })

  it('waits for a newer surviving-host frame before repairing shared state', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-a')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()
    await publish(findGlobalSubscription(ENV_B, 1), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-b')]
    })

    const newerRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => newerRecovery.promise)
    await publish(findGlobalSubscription(ENV_B, 1), {
      type: 'updated',
      ...makeTerminalSnapshot('-b', 2)
    })
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'snapshots',
      snapshots: [],
      authoritative: true
    })
    const tabId = toWebTerminalSurfaceTabId('host-tab-b')
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([tabId])
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(2)

    newerRecovery.resolve(makeTerminalSnapshot('-b', 2))
    await act(settle)

    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([tabId])
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(1)
    hook.unmount()
  })

  it('fences an omitted host while its survivor inventory is unavailable', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-a')]
    })
    await publish(findGlobalSubscription(ENV_B), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-b')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()

    const staleRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    const slowInventoryRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot
      .mockImplementationOnce(() => staleRecovery.promise)
      .mockImplementationOnce(() => slowInventoryRecovery.promise)
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'updated',
      ...makeTerminalSnapshot('-a', 2)
    })
    const unrelatedSnapshot = {
      ...makeTerminalSnapshot('-a'),
      worktree: 'repo-a::other-worktree'
    }
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'snapshots',
      snapshots: [unrelatedSnapshot],
      authoritative: true
    })
    const hostBTabId = toWebTerminalSurfaceTabId('host-tab-b')
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      hostBTabId
    ])

    staleRecovery.resolve(makeTerminalSnapshot('-a', 2))
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      hostBTabId
    ])

    slowInventoryRecovery.resolve(unrelatedSnapshot)
    await act(settle)
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'updated',
      ...makeTerminalSnapshot('-a', 3)
    })
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      toWebTerminalSurfaceTabId('host-tab-a')
    ])
    hook.unmount()
  })

  it('caches semantic freshness instead of later receive order', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-a')]
    })
    await publish(findGlobalSubscription(ENV_B), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-b')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()

    const newerRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => newerRecovery.promise)
    await publish(findActiveSubscription(ENV_A, 1), {
      type: 'snapshot',
      ...makeTerminalSnapshot('-a', 2)
    })
    await publish(findActiveSubscription(ENV_A, 1), {
      type: 'snapshot',
      ...makeTerminalSnapshot('-a')
    })
    newerRecovery.resolve(makeTerminalSnapshot('-a', 2))
    await act(settle)

    await publish(findGlobalSubscription(ENV_B, 1), {
      type: 'snapshots',
      snapshots: [],
      authoritative: true
    })
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(1)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      toWebTerminalSurfaceTabId('host-tab-a')
    ])
    hook.unmount()
  })

  it('keeps a newer recovered frame when its resume inventory finishes later', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-a')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()

    const slowInventory = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => slowInventory.promise)
    await publish(findGlobalSubscription(ENV_B, 1), {
      type: 'snapshots',
      snapshots: [makeTerminalSnapshot('-b')]
    })
    await publish(findGlobalSubscription(ENV_B, 1), {
      type: 'updated',
      ...makeTerminalSnapshot('-b', 2)
    })
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'snapshots',
      snapshots: [],
      authoritative: true
    })

    slowInventory.resolve(makeTerminalSnapshot('-b'))
    await act(settle)

    const tabId = toWebTerminalSurfaceTabId('host-tab-b')
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([tabId])
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(1)
    hook.unmount()
  })

  it('keeps a post-inventory live frame ahead of an older pending recovery', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeTerminalSnapshot('-a')
    await publish(findGlobalSubscription(ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await settleGlobalMirrorResumeStarts()

    const slowActiveRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => slowActiveRecovery.promise)
    const pendingSnapshot = makeTerminalSnapshot('-b', 3)
    await publish(findActiveSubscription(ENV_A, 1), {
      type: 'snapshot',
      ...pendingSnapshot
    })
    await publish(findGlobalSubscription(ENV_A, 1), {
      type: 'snapshots',
      snapshots: [],
      authoritative: true
    })

    expect(useAppStore.getState().tabsByWorktree[WORKTREE]).toBeUndefined()
    expect(_getWebSessionTabsRecoveryTrackingCountsForTest()).toEqual({
      pendingRecoveries: 1,
      removalFrames: 1
    })
    const liveSnapshot = makeTerminalSnapshot('-a', 2)
    await publish(findActiveSubscription(ENV_A, 1), {
      type: 'updated',
      ...liveSnapshot
    })
    const liveTabId = toWebTerminalSurfaceTabId('host-tab-a')
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      liveTabId
    ])

    slowActiveRecovery.resolve(pendingSnapshot)
    await act(settle)
    expect(useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([
      liveTabId
    ])
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(1)
    expect(_getWebSessionTabsRecoveryTrackingCountsForTest()).toEqual({
      pendingRecoveries: 0,
      removalFrames: 0
    })
    hook.unmount()
  })

  it('does not let old cleanup erase a new recovery generation', async () => {
    const oldRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => oldRecovery.promise)
    const oldHook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeTerminalSnapshot('-a')
    await publish(findActiveSubscription(ENV_A), { type: 'snapshot', ...snapshot })
    oldHook.unmount()

    const newRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => newRecovery.promise)
    const newHook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findActiveSubscription(ENV_A, 1), { type: 'snapshot', ...snapshot })
    expect(_getWebSessionTabsRecoveryTrackingCountsForTest().pendingRecoveries).toBe(1)

    oldRecovery.resolve(snapshot)
    await act(settle)
    expect(_getWebSessionTabsRecoveryTrackingCountsForTest().pendingRecoveries).toBe(1)

    newRecovery.resolve(snapshot)
    await act(settle)
    expect(_getWebSessionTabsRecoveryTrackingCountsForTest().pendingRecoveries).toBe(0)
    newHook.unmount()
  })

  it('tracks repeated same-worktree recoveries in constant map space', async () => {
    const recoveries = [
      createDeferred<RuntimeMobileSessionTabsResult>(),
      createDeferred<RuntimeMobileSessionTabsResult>(),
      createDeferred<RuntimeMobileSessionTabsResult>()
    ]
    for (const recovery of recoveries) {
      mocks.recoverSnapshot.mockImplementationOnce(() => recovery.promise)
    }
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const activeSubscription = findActiveSubscription(ENV_A)
    for (const [index] of recoveries.entries()) {
      await publish(activeSubscription, {
        type: 'updated',
        ...makeTerminalSnapshot(index === 0 ? '-a' : '-b', index + 1)
      })
    }
    expect(_getWebSessionTabsRecoveryTrackingCountsForTest().pendingRecoveries).toBe(1)

    for (const [index, recovery] of recoveries.entries()) {
      recovery.resolve(makeTerminalSnapshot(index === 0 ? '-a' : '-b', index + 1))
    }
    await act(settle)
    expect(_getWebSessionTabsRecoveryTrackingCountsForTest().pendingRecoveries).toBe(0)
    hook.unmount()
  })
})
