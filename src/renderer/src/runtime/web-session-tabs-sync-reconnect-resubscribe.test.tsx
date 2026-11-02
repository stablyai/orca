// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  ownerEnvironmentIdForWorkspace: vi.fn(),
  recheckUnconfirmedLaunches: vi.fn()
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-unconfirmed-recheck', () => ({
  recheckUnconfirmedStructuredAgentLaunches: mocks.recheckUnconfirmedLaunches
}))

vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (state: unknown, workspaceId: string | null) =>
    workspaceId ? (mocks.ownerEnvironmentIdForWorkspace(state, workspaceId) ?? null) : null
}))

import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from './host-live-terminal-probe'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { useWebSessionTabsSync } from './web-session-tabs-sync/use-web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import './use-runtime-session-mirror-environment-key'
import { publicRuntimeEnvironment } from './paired-runtime-environment-test-fixture'

const ENV_A = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const REVISION_A = 101
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type Recorded = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: Recorded[] = []
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

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

function hostSnapshot(
  sequence: number,
  patch: Partial<RuntimeHostStatusSnapshot> = {}
): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENV_A,
    pairingRevision: REVISION_A,
    sequence,
    checkedAt: sequence,
    status: makeStatus('runtime-a'),
    verification: 'verified',
    transport: 'ready',
    ...patch
  }
}

function mirroredSubscriptions(method: string): Recorded[] {
  return subscriptions.filter((entry) => entry.request.method === method)
}

function makeStatus(runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

/** Connect, then lose contact over a still-ready transport: the stream ends, the probe cannot ask. */
async function connectThenLoseContact(): Promise<void> {
  renderHook(() => useWebSessionTabsSync())
  await act(async () => {
    useAppStore.getState().applyRuntimeHostStatusSnapshot(hostSnapshot(1))
    await settle()
  })
  await act(async () => {
    for (const entry of subscriptions) {
      entry.callbacks.onResponse({
        id: 'ended',
        ok: true,
        result: { type: 'end' },
        _meta: { runtimeId: 'runtime-a' }
      })
    }
    useAppStore
      .getState()
      .applyRuntimeHostStatusSnapshot(hostSnapshot(2, { verification: 'unavailable' }))
    await settle()
  })
}

async function regainContact(): Promise<void> {
  await act(async () => {
    useAppStore.getState().applyRuntimeHostStatusSnapshot(hostSnapshot(3))
    await settle()
  })
}

describe('session-tabs mirror across an outage and its recovery', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.ownerEnvironmentIdForWorkspace.mockReset().mockReturnValue(ENV_A)
    mocks.recheckUnconfirmedLaunches.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearHostLiveTerminalProbesForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    const runtimeEnvironments = [
      publicRuntimeEnvironment({ id: ENV_A, createdAt: 100, pairingRevision: REVISION_A })
    ]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: ENV_A },
        activeWorktreeId: WORKTREE,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: new Map()
      },
      true
    )
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  // Recovered contact must reinstall dead streams: end frames and parking retries cannot revive them.
  it('reinstalls both session-tabs subscriptions when the host answers again', async () => {
    await connectThenLoseContact()
    const stranded = {
      all: mirroredSubscriptions('session.tabs.subscribeAll').length,
      active: mirroredSubscriptions('session.tabs.subscribe').length,
      signal: mirrorKeys().resubscribeSignal
    }

    await regainContact()

    expect(mirrorKeys().resubscribeSignal).not.toBe(stranded.signal)
    expect(mirroredSubscriptions('session.tabs.subscribeAll')).toHaveLength(stranded.all + 1)
    expect(mirroredSubscriptions('session.tabs.subscribe')).toHaveLength(stranded.active + 1)
  })
})
