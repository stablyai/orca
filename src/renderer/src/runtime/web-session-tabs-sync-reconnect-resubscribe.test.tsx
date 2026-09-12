// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

const mocks = vi.hoisted(() => ({ getExplicitRuntimeEnvironmentIdForWorktree: vi.fn() }))

vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
  }
})

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from './host-live-terminal-probe'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { buildRuntimeSessionMirrorEnvironmentKeys } from './use-runtime-session-mirror-environment-key'

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
    status: { runtimeId: 'runtime-a' } as RuntimeHostStatusSnapshot['status'],
    verification: 'verified',
    transport: 'ready',
    ...patch
  }
}

function mirroredSubscriptions(method: string): Recorded[] {
  return subscriptions.filter((entry) => entry.request.method === method)
}

/** The dependencies the mirror-subscription effects actually read, rebuilt from current state. */
function mirrorKeys(): ReturnType<typeof buildRuntimeSessionMirrorEnvironmentKeys> {
  const state = useAppStore.getState()
  return buildRuntimeSessionMirrorEnvironmentKeys({
    activeRuntimeEnvironmentId: state.settings?.activeRuntimeEnvironmentId ?? null,
    repos: state.repos,
    worktreesByRepo: state.worktreesByRepo,
    detectedWorktreesByRepo: state.detectedWorktreesByRepo,
    projectGroups: state.projectGroups,
    restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey,
    runtimeEnvironments: state.runtimeEnvironments,
    runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId
  } as Parameters<typeof buildRuntimeSessionMirrorEnvironmentKeys>[0])
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
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearHostLiveTerminalProbesForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    const runtimeEnvironments = [
      { id: ENV_A, createdAt: 100, pairingRevision: REVISION_A }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: ENV_A },
        activeWorktreeId: WORKTREE,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: new Map() as AppState['runtimeStatusByEnvironmentId']
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

  // Direction 1: the resubscribe trigger. The transport took both streams with it and nothing
  // else revives them -- an 'end' frame resubscribes nothing and the parking layer retries only
  // a rejected subscribe -- so regaining contact has to reinstall them itself.
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

  // Direction 2: the mirror's cache key. #19647 -- recovery is not a second connection, so every
  // retained-state stamp cut from this key stays valid and the mirror is never rebuilt.
  it('holds the mirror environment key across the outage and the recovery', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(async () => {
      useAppStore.getState().applyRuntimeHostStatusSnapshot(hostSnapshot(1))
      await settle()
    })
    const connectedKey = mirrorKeys().environmentKey
    expect(connectedKey).not.toBe('')

    await act(async () => {
      useAppStore
        .getState()
        .applyRuntimeHostStatusSnapshot(hostSnapshot(2, { verification: 'unavailable' }))
      await settle()
    })
    expect(mirrorKeys().environmentKey).toBe(connectedKey)

    await regainContact()
    expect(mirrorKeys().environmentKey).toBe(connectedKey)
  })

  // The two values only look alike: a replacement runtime is a new connection, so the key moves
  // and the mirror is meant to be rebuilt.
  it('still rebuilds the mirror key when the host returns as a replacement runtime', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(async () => {
      useAppStore.getState().applyRuntimeHostStatusSnapshot(hostSnapshot(1))
      await settle()
    })
    const connectedKey = mirrorKeys().environmentKey

    await act(async () => {
      useAppStore
        .getState()
        .applyRuntimeHostStatusSnapshot(hostSnapshot(2, { verification: 'unavailable' }))
      useAppStore.getState().applyRuntimeHostStatusSnapshot(
        hostSnapshot(3, {
          status: { runtimeId: 'runtime-b' } as RuntimeHostStatusSnapshot['status']
        })
      )
      await settle()
    })

    expect(mirrorKeys().environmentKey).not.toBe(connectedKey)
  })
})
