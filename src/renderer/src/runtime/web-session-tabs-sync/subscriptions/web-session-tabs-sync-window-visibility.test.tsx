// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tagRuntimeSubscriptionReplayResponse } from '../../../../../shared/runtime-subscription-replay'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
import type * as WebRuntimeTerminalCreationModule from '../../hosted-terminals/creation/web-runtime-terminal-creation'

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  ownerEnvironmentIdForWorkspace: vi.fn(),
  recoverSnapshot: vi.fn(),
  runtimeSessionMirrorEnvironmentKey: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKeys: () => ({
    environmentKey: mocks.runtimeSessionMirrorEnvironmentKey(),
    resubscribeSignal: ''
  })
}))

vi.mock('../mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (state: unknown, workspaceId: string | null) =>
    workspaceId ? (mocks.ownerEnvironmentIdForWorkspace(state, workspaceId) ?? null) : null
}))

vi.mock('../../hosted-terminals/recovery/web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverSnapshot
}))

vi.mock('../../hosted-terminals/creation/web-runtime-terminal-creation', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalCreationModule>()
  return {
    ...actual,
    createWebRuntimeSessionTerminal: mocks.createTerminal
  }
})

import { useAppStore } from '@/store/index'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from '../../hosted-terminals/inventory/host-live-terminal-probe'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../tracking-lifecycle'
import { useWebSessionTabsSync } from '../use-web-session-tabs-sync'
import { WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS } from '../state'
import { clearRuntimeEnvironmentConnectionGenerations as clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { WINDOW_HIDE_PARK_GRACE_MS as WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from '../../../lib/window-activity/window-park-visibility'
import {
  connectedRuntimeStatus,
  publicRuntimeEnvironment
} from '../../rpc/testing/paired-runtime-environment-test-fixture'

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

/** Empty inventories require terminal.list readiness probes before settling; classify calls by method rather than bare count (STA-5377). */

/** Both seeded environments answer an empty inventory, so each owes a probe. */

const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

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
    publicRuntimeEnvironment({ id: ENV_A, createdAt: 100, pairingRevision: REVISION_A }),
    publicRuntimeEnvironment({ id: ENV_B, createdAt: 200, pairingRevision: REVISION_B })
  ]
  replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
  useAppStore.setState(
    {
      ...initialState,
      activeWorktreeId: WORKTREE,
      workspaceSessionReady: true,
      runtimeEnvironments,
      runtimeStatusByEnvironmentId: new Map([
        [ENV_A, connectedRuntimeStatus('runtime-a', 1)],
        [ENV_B, connectedRuntimeStatus('runtime-b', 2)]
      ])
    },
    true
  )
}

/** A host that negotiated `session-tabs.authoritative-inventory.v1` labels a complete census. */
function authoritativeInventory(snapshots: RuntimeMobileSessionTabsResult[]): {
  type: 'snapshots'
  snapshots: RuntimeMobileSessionTabsResult[]
  authoritative: true
} {
  return { type: 'snapshots', snapshots, authoritative: true }
}

describe('useWebSessionTabsSync window visibility', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue(undefined)
    mocks.recoverSnapshot.mockReset().mockImplementation(async (_state, snapshot) => snapshot)
    mocks.ownerEnvironmentIdForWorkspace.mockReset().mockReturnValue(ENV_A)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
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
    resetStaleDocumentVisibilityForTesting()
    setDocumentVisibility('visible')
    vi.useRealTimers()
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
    await publish(
      findSubscription('session.tabs.subscribeAll', ENV_A, 1),
      authoritativeInventory([])
    )

    const handles = Object.values(useAppStore.getState().remoteBrowserPageHandlesByPageId)
    expect(handles.some((handle) => handle.environmentId === ENV_A)).toBe(false)
    expect(handles.some((handle) => handle.environmentId === ENV_B)).toBe(true)
    expect(useAppStore.getState().activeBrowserTabIdByWorktree[WORKTREE]).toBe(
      'host-browser-workspace-b'
    )
    expect(useAppStore.getState().tabBarOrderByWorktree[WORKTREE]).toEqual(['host-browser-tab-b'])
    hook.unmount()
  })
})
