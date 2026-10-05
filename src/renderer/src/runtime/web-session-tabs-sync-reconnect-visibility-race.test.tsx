// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'
import type * as WebRuntimeSessionModule from './web-runtime-session'

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn(),
  runtimeSessionMirrorResubscribeSignal: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKeys: () => ({
    environmentKey: mocks.runtimeSessionMirrorEnvironmentKey(),
    resubscribeSignal: mocks.runtimeSessionMirrorResubscribeSignal()
  })
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
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from './host-live-terminal-probe'
import {
  _getWebSessionTabsTrackingCountsForTest,
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync,
  WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS
} from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WORKTREE = 'repo-a::worktree-a'
const REVISION_A = 101
const REVISION_B = 201
const MIRROR_KEY = `${ENV_A}\u0001runtime-a\u00010\u0001${REVISION_A}\u0000${ENV_B}\u0001runtime-b\u00010\u0001${REVISION_B}`
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: RuntimeSubscription[] = []
const runtimeCall = vi.fn(async (_args: { method: string }) => ({
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

function makeBrowserSnapshot(idSuffix = ''): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
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

function runtimeInventoryCallCount(): number {
  return runtimeCall.mock.calls.filter(([args]) => args.method === 'session.tabs.listAll').length
}

function seedRemoteMirrorState(): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror scan and revision ledger read only id, createdAt and pairingRevision.
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the subscription installer reads only runtimeId and connectionGeneration from these fixture entries.
      runtimeStatusByEnvironmentId: new Map([
        [ENV_A, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }],
        [ENV_B, { status: { runtimeId: 'runtime-b' }, connectionGeneration: 2 }]
      ]) as AppState['runtimeStatusByEnvironmentId']
    },
    true
  )
}

function authoritativeInventory(snapshots: RuntimeMobileSessionTabsResult[]): {
  type: 'snapshots'
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative: true
} {
  return { type: 'snapshots', snapshots, authoritative: true }
}

describe('session-tabs reconnect during a visibility resume', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    mocks.runtimeSessionMirrorResubscribeSignal
      .mockReset()
      .mockReturnValue('env-a\u00010\u0000env-b\u00010')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    setDocumentVisibility('visible')
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearHostLiveTerminalProbesForTests()
    seedRemoteMirrorState()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    setDocumentVisibility('visible')
    vi.useRealTimers()
  })

  it('keeps replacement inventory in the pending resume batch', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const snapshotA = makeBrowserSnapshot('-a')
    const snapshotB = makeBrowserSnapshot('-b')
    await publish(findSubscription('session.tabs.subscribeAll', ENV_A), {
      type: 'snapshots',
      snapshots: [snapshotA]
    })
    await publish(findSubscription('session.tabs.subscribeAll', ENV_B), {
      type: 'snapshots',
      snapshots: [snapshotB]
    })

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS)
    })
    await act(settle)
    const resumedA = findSubscription('session.tabs.subscribeAll', ENV_A, 1)
    const resumedB = findSubscription('session.tabs.subscribeAll', ENV_B, 1)

    // Leave B's inventory pending so A's omission stays in the same resume batch.
    await publish(resumedA, authoritativeInventory([]))
    const listAllBeforeReconnect = runtimeInventoryCallCount()
    mocks.runtimeSessionMirrorResubscribeSignal.mockReturnValue('env-a\u00011\u0000env-b\u00010')
    hook.rerender()
    await act(settle)

    expect(runtimeInventoryCallCount()).toBe(listAllBeforeReconnect)
    const replacementA = findSubscription('session.tabs.subscribeAll', ENV_A, 2)
    await publish(resumedA, authoritativeInventory([]))
    await publish(replacementA, {
      type: 'snapshots',
      snapshots: [{ ...snapshotA, snapshotVersion: 2 }]
    })
    await publish(resumedB, {
      type: 'snapshots',
      snapshots: [{ ...snapshotB, snapshotVersion: 2 }]
    })

    expect(useAppStore.getState().browserTabsByWorktree[WORKTREE]).toHaveLength(2)
    expect(_getWebSessionTabsTrackingCountsForTest().freshness).toBe(2)

    // A later reconnect is outside the settled batch and may use the bootstrap fallback again.
    mocks.runtimeSessionMirrorResubscribeSignal.mockReturnValue('env-a\u00012\u0000env-b\u00010')
    hook.rerender()
    await act(settle)
    expect(runtimeInventoryCallCount()).toBe(listAllBeforeReconnect + 1)
    hook.unmount()
  })
})
