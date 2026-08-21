// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
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
  acceptReplayedWebSessionTabsSnapshot,
  _getWebSessionTabsRecoveryTrackingCountsForTest,
  _getWebSessionTabsTrackingCountsForTest,
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync,
  WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS
} from './web-session-tabs-sync'
import {
  WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT,
  WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS
} from './window-visibility-subscription-parking'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WORKTREE = 'repo-a::worktree-a'
const REVISION_A = 101
const REVISION_B = 201
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

function makeEmptySnapshot(snapshotVersion = 1): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

function makeBrowserSnapshot(idSuffix = ''): RuntimeMobileSessionTabsResult {
  return {
    ...makeEmptySnapshot(),
    activeTabId: `host-browser-tab${idSuffix}`,
    activeTabType: 'browser',
    tabs: [
      {
        type: 'browser',
        id: `host-browser-tab${idSuffix}`,
        title: 'Remote browser',
        browserWorkspaceId: `host-browser-workspace${idSuffix}`,
        browserPageId: `host-browser-page${idSuffix}`,
        url: 'https://example.com/',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: true
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

function findSubscription(
  method: 'session.tabs.subscribeAll' | 'session.tabs.subscribe',
  selector: string,
  occurrence = 0
): RuntimeSubscription {
  const matches = subscriptions.filter(
    ({ request }) => request.method === method && request.selector === selector
  )
  const subscription = matches[occurrence]
  if (!subscription) {
    throw new Error(`Missing ${method} subscription ${occurrence} for ${selector}`)
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
      _meta: { runtimeId: 'runtime-test' }
    }
    subscription.callbacks.onResponse(
      replayed ? tagRuntimeSubscriptionReplayResponse(response) : response
    )
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

describe('useWebSessionTabsSync window visibility', () => {
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

  it('parks every live mirror without repeating one-shot hydration', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    expect(runtimeCall).toHaveBeenCalledTimes(2)
    expect(runtimeSubscribe).toHaveBeenCalledTimes(3)
    expect(subscriptions.map(({ request }) => request.method).sort()).toEqual([
      'session.tabs.subscribe',
      'session.tabs.subscribeAll',
      'session.tabs.subscribeAll'
    ])

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS - 1)
    })
    expect(subscriptions.every(({ unsubscribe }) => unsubscribe.mock.calls.length === 0)).toBe(true)

    act(() => vi.advanceTimersByTime(1))
    expect(subscriptions.every(({ unsubscribe }) => unsubscribe.mock.calls.length === 1)).toBe(true)

    act(() => setDocumentVisibility('visible'))
    act(() => vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS))
    await act(settle)
    expect(runtimeSubscribe).toHaveBeenCalledTimes(6)
    expect(runtimeCall).toHaveBeenCalledTimes(2)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS - 1)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(1)
    })
    expect(runtimeSubscribe).toHaveBeenCalledTimes(6)

    hook.unmount()
    expect(
      subscriptions.slice(3).every(({ unsubscribe }) => unsubscribe.mock.calls.length === 1)
    ).toBe(true)
  })

  it('skips recovery and store replay for an unchanged resume inventory', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeBrowserSnapshot()
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })
    const browserTabsByWorktree = useAppStore.getState().browserTabsByWorktree
    mocks.recoverSnapshot.mockClear()

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: [snapshot]
    })

    expect(mocks.recoverSnapshot).not.toHaveBeenCalled()
    expect(useAppStore.getState().browserTabsByWorktree).toBe(browserTabsByWorktree)

    act(() => useAppStore.setState({ browserTabsByWorktree: {} }))
    await publish(
      findSubscription('session.tabs.subscribeAll', ENV_A, 1),
      { type: 'snapshots', snapshots: [snapshot] },
      true
    )
    expect(mocks.recoverSnapshot).toHaveBeenCalledOnce()
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toHaveLength(1)
    hook.unmount()
  })

  it('replays an unchanged resume inventory while a repair replay is armed', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeBrowserSnapshot()
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })
    mocks.recoverSnapshot.mockClear()
    acceptReplayedWebSessionTabsSnapshot(ENV_A, WORKTREE)
    act(() => useAppStore.setState({ browserTabsByWorktree: {} }))

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: [snapshot]
    })

    expect(mocks.recoverSnapshot).toHaveBeenCalledOnce()
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toHaveLength(1)
    hook.unmount()
  })

  it('starts hidden without remote IO and hydrates once on reveal', async () => {
    setDocumentVisibility('hidden')
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)

    expect(runtimeCall).not.toHaveBeenCalled()
    expect(runtimeSubscribe).not.toHaveBeenCalled()

    act(() => setDocumentVisibility('visible'))
    act(() => vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS))
    await act(settle)
    expect(runtimeCall).toHaveBeenCalledTimes(2)
    expect(runtimeSubscribe).toHaveBeenCalledTimes(3)
    hook.unmount()
  })

  it('does not bootstrap twice when global snapshots race active resume', async () => {
    const pendingCreate = createDeferred<unknown>()
    mocks.createTerminal.mockReturnValue(pendingCreate.promise)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeEmptySnapshot()

    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })
    await publish(findSubscription('session.tabs.subscribe', ENV_A), {
      type: 'snapshot',
      ...snapshot
    })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS)
    })
    await act(settle)

    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: [snapshot]
    })
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 1), {
      type: 'snapshot',
      ...snapshot
    })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)

    pendingCreate.resolve(undefined)
    await act(settle)
    hook.unmount()
  })

  it('keeps a newer active snapshot when an older frame is received later', async () => {
    const newerRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    const olderRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot
      .mockImplementationOnce(() => newerRecovery.promise)
      .mockImplementationOnce(() => olderRecovery.promise)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const newerSnapshot = { ...makeBrowserSnapshot('-new'), snapshotVersion: 2 }
    const olderSnapshot = makeBrowserSnapshot('-old')
    const activeSubscription = findSubscription('session.tabs.subscribe', ENV_A)

    await publish(activeSubscription, { type: 'snapshot', ...newerSnapshot })
    await publish(activeSubscription, { type: 'snapshot', ...olderSnapshot })
    newerRecovery.resolve(newerSnapshot)
    await act(settle)
    expect(useAppStore.getState().activeBrowserTabIdByWorktree[WORKTREE]).toBe(
      'host-browser-workspace-new'
    )

    olderRecovery.resolve(olderSnapshot)
    await act(settle)
    expect(useAppStore.getState().activeBrowserTabIdByWorktree[WORKTREE]).toBe(
      'host-browser-workspace-new'
    )
    hook.unmount()
  })

  it('removes an omitted mirror without waiting for an unrelated host inventory', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeBrowserSnapshot()

    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toHaveLength(1)
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(1)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: []
    })

    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(0)
    hook.unmount()
  })

  it('removes an omitted host before replaying a collision created while hidden', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [makeBrowserSnapshot('-a')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS)
    })
    await act(settle)

    await publish(findSubscription('session.tabs.subscribeAll', ENV_B, 1), {
      type: 'snapshots',
      snapshots: [makeBrowserSnapshot('-b')]
    })
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: []
    })

    const handles = Object.values(useAppStore.getState().remoteBrowserPageHandlesByPageId)
    expect(handles.some((handle) => handle.environmentId === ENV_A)).toBe(false)
    expect(handles.some((handle) => handle.environmentId === ENV_B)).toBe(true)
    expect(useAppStore.getState().activeBrowserTabIdByWorktree[WORKTREE]).toBe(
      'host-browser-workspace-b'
    )
    expect(useAppStore.getState().tabBarOrderByWorktree[WORKTREE]).toEqual(['host-browser-tab-b'])
    hook.unmount()
  })

  it('removes the remaining host mirror after a colliding host is removed', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [makeBrowserSnapshot('-a')]
    })
    await publish(findSubscription('session.tabs.subscribeAll', ENV_B), {
      type: 'snapshots',
      snapshots: [makeBrowserSnapshot('-b')]
    })
    await publish(findSubscription('session.tabs.subscribeAll', ENV_B), {
      type: 'updated',
      ...makeEmptySnapshot(2),
      removed: true
    })
    expect(
      Object.values(useAppStore.getState().remoteBrowserPageHandlesByPageId).some(
        (handle) => handle.environmentId === ENV_A
      )
    ).toBe(true)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: []
    })

    expect(
      Object.values(useAppStore.getState().remoteBrowserPageHandlesByPageId).some(
        (handle) => handle.environmentId === ENV_A
      )
    ).toBe(false)
    hook.unmount()
  })

  it('does not let a slow resume inventory remove a newer update', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeBrowserSnapshot()
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    const slowOtherSnapshot = {
      ...makeEmptySnapshot(),
      worktree: 'repo-a::other-worktree'
    }
    const slowInventoryRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    const slowUpdateRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot
      .mockImplementationOnce(() => slowInventoryRecovery.promise)
      .mockImplementationOnce(() => slowUpdateRecovery.promise)
    const resumedGlobal = findSubscription('session.tabs.subscribeAll', ENV_A, 1)
    await publish(resumedGlobal, {
      type: 'snapshots',
      snapshots: [slowOtherSnapshot]
    })
    await publish(resumedGlobal, {
      type: 'updated',
      ...snapshot,
      snapshotVersion: 2
    })
    slowInventoryRecovery.resolve(slowOtherSnapshot)
    await act(settle)
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toHaveLength(1)
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(2)
    slowUpdateRecovery.resolve({ ...snapshot, snapshotVersion: 2 })
    await act(settle)
    hook.unmount()
  })

  it('keeps a newer active snapshot received before the resume inventory', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const originalSnapshot = makeBrowserSnapshot('-old')
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [originalSnapshot]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)

    const newerSnapshot = { ...makeBrowserSnapshot('-new'), snapshotVersion: 2 }
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 1), {
      type: 'snapshot',
      ...newerSnapshot
    })
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: []
    })

    expect(useAppStore.getState().activeBrowserTabIdByWorktree[WORKTREE]).toBe(
      'host-browser-workspace-new'
    )
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(1)
    hook.unmount()
  })

  it('reconciles a missed removal after the mirror effect restarts hidden', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeBrowserSnapshot()
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(1)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(
      MIRROR_KEY.replace('runtime-b\u00012', 'runtime-b\u00013')
    )
    hook.rerender()
    await act(settle)
    expect(runtimeSubscribe).toHaveBeenCalledTimes(3)

    act(() => setDocumentVisibility('visible'))
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: []
    })

    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()
    expect(
      Object.values(useAppStore.getState().remoteBrowserPageHandlesByPageId).some(
        (handle) => handle.environmentId === ENV_A
      )
    ).toBe(false)
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(0)

    await publish(findSubscription('session.tabs.subscribe', ENV_A, 1), {
      type: 'snapshot',
      ...snapshot
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()
    hook.unmount()
  })

  it('clears hidden tracking when its environment is no longer mirrored', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [makeBrowserSnapshot()]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    })
    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(MIRROR_KEY.split('\u0000')[1])
    hook.rerender()
    await act(settle)

    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(0)
    act(() => setDocumentVisibility('visible'))
    await act(settle)
    expect(
      subscriptions.filter(
        ({ request }) =>
          request.method === 'session.tabs.subscribeAll' && request.selector === ENV_A
      )
    ).toHaveLength(1)
    hook.unmount()
  })

  it('ignores an older inventory completion after a newer inventory', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [makeBrowserSnapshot('-old')]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)

    const unrelatedSnapshot = {
      ...makeEmptySnapshot(),
      worktree: 'repo-a::other-worktree'
    }
    const olderInventoryRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => olderInventoryRecovery.promise)
    const resumedGlobal = findSubscription('session.tabs.subscribeAll', ENV_A, 1)
    await publish(resumedGlobal, {
      type: 'snapshots',
      snapshots: [unrelatedSnapshot]
    })
    const newerSnapshot = { ...makeBrowserSnapshot('-new'), snapshotVersion: 2 }
    await publish(resumedGlobal, {
      type: 'snapshots',
      snapshots: [newerSnapshot]
    })

    olderInventoryRecovery.resolve(unrelatedSnapshot)
    await act(settle)
    expect(useAppStore.getState().activeBrowserTabIdByWorktree[WORKTREE]).toBe(
      'host-browser-workspace-new'
    )
    hook.unmount()
  })

  it.each([
    { label: 'exact', snapshotVersion: 2 },
    { label: 'older', snapshotVersion: 1 }
  ])(
    'lets an authoritative inventory beat a later $label active replay',
    async ({ snapshotVersion }) => {
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(settle)
      const snapshot = { ...makeBrowserSnapshot(), snapshotVersion: 2 }
      await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
        type: 'snapshots',
        snapshots: [snapshot]
      })

      act(() => {
        setDocumentVisibility('hidden')
        vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
        setDocumentVisibility('visible')
      })
      await act(settle)

      const unrelatedSnapshot = {
        ...makeEmptySnapshot(),
        worktree: 'repo-a::other-worktree'
      }
      const slowInventoryRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
      mocks.recoverSnapshot.mockImplementationOnce(() => slowInventoryRecovery.promise)
      await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
        type: 'snapshots',
        snapshots: [unrelatedSnapshot]
      })
      await publish(findSubscription('session.tabs.subscribe', ENV_A, 1), {
        type: 'snapshot',
        ...snapshot,
        snapshotVersion
      })

      slowInventoryRecovery.resolve(unrelatedSnapshot)
      await act(settle)
      expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()
      hook.unmount()
    }
  )

  it('keeps an omission authoritative after its resume batch completes', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = { ...makeBrowserSnapshot(), snapshotVersion: 2 }
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
    })
    await act(settle)
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: []
    })
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 1), {
      type: 'snapshot',
      ...snapshot
    })

    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()

    mocks.runtimeSessionMirrorEnvironmentKey.mockReturnValue(
      MIRROR_KEY.replace('runtime-b\u00012', 'runtime-b\u00013')
    )
    hook.rerender()
    await act(settle)
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 1), {
      type: 'snapshot',
      ...snapshot
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()

    act(() => {
      setDocumentVisibility('hidden')
      // A second park in the same install pays the widened park delay.
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS * 2)
      setDocumentVisibility('visible')
    })
    await act(settle)
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 2), {
      type: 'snapshot',
      ...snapshot
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()
    hook.unmount()
  })

  it('drops an omission fence one generation after the inventory that set it', async () => {
    const parkAndReveal = async (): Promise<void> => {
      act(() => {
        setDocumentVisibility('hidden')
        vi.advanceTimersByTime(
          WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS *
            WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT
        )
        setDocumentVisibility('visible')
      })
      await act(settle)
    }
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = { ...makeBrowserSnapshot(), snapshotVersion: 2 }
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshot]
    })

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A, 1), {
      type: 'snapshots',
      snapshots: []
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 2), {
      type: 'snapshot',
      ...snapshot
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toBeUndefined()

    await parkAndReveal()
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 3), {
      type: 'snapshot',
      ...snapshot
    })
    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toHaveLength(1)
    hook.unmount()
  })

  it('fences recovery that finishes after the stream is parked', async () => {
    const deferredRecovery = createDeferred<RuntimeMobileSessionTabsResult>()
    mocks.recoverSnapshot.mockImplementationOnce(() => deferredRecovery.promise)
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshot = makeEmptySnapshot()

    await publish(findSubscription('session.tabs.subscribe', ENV_A), {
      type: 'snapshot',
      ...snapshot
    })
    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    })
    deferredRecovery.resolve(snapshot)
    await act(settle)
    expect(mocks.createTerminal).not.toHaveBeenCalled()

    act(() => setDocumentVisibility('visible'))
    await act(settle)
    await publish(findSubscription('session.tabs.subscribe', ENV_A, 1), {
      type: 'snapshot',
      ...snapshot
    })
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    hook.unmount()
  })
})
