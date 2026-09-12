// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

const mocks = vi.hoisted(() => ({
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn(),
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

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from './host-live-terminal-probe'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'

const ENV_A = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const REVISION_A = 101
const MIRROR_KEY = `${ENV_A}runtime-a0${REVISION_A}`
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeSubscription = {
  request: Parameters<RuntimeSubscribe>[0]
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: RuntimeSubscription[] = []
const runtimeCall = vi.fn(async (_args: { method: string }) => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-a' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function verifiedSnapshot(): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENV_A,
    pairingRevision: REVISION_A,
    sequence: 1,
    checkedAt: 1,
    status: { runtimeId: 'runtime-a' } as RuntimeHostStatusSnapshot['status'],
    verification: 'verified',
    transport: 'ready'
  }
}

function setRuntimeStatusEntry(entry: unknown): void {
  useAppStore.setState({
    runtimeStatusByEnvironmentId: new Map([
      [ENV_A, entry]
    ]) as AppState['runtimeStatusByEnvironmentId']
  })
}

function activeTabsSubscriptions(): RuntimeSubscription[] {
  return subscriptions.filter(({ request }) => request.method === 'session.tabs.subscribe')
}

describe('useWebSessionTabsSync under an unverifiable host probe', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    mocks.runtimeSessionMirrorEnvironmentKey.mockReset().mockReturnValue(MIRROR_KEY)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    clearHostLiveTerminalProbesForTests()
    const runtimeEnvironments = [
      { id: ENV_A, createdAt: 100, pairingRevision: REVISION_A }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: WORKTREE,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: new Map([
          [
            ENV_A,
            {
              status: { runtimeId: 'runtime-a' },
              snapshot: verifiedSnapshot(),
              connectionGeneration: 1
            }
          ]
        ]) as AppState['runtimeStatusByEnvironmentId']
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

  it('holds the active session-tabs subscription when the probe goes unverifiable', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const held = activeTabsSubscriptions()
    expect(held).toHaveLength(1)

    // The transport is still ready and the host is still delivering; only the probe failed.
    await act(async () => {
      setRuntimeStatusEntry({
        status: null,
        snapshot: { ...verifiedSnapshot(), sequence: 2, checkedAt: 2, verification: 'unavailable' },
        connectionGeneration: 1
      })
      await settle()
    })

    expect(held[0]!.unsubscribe).not.toHaveBeenCalled()
    expect(activeTabsSubscriptions()).toHaveLength(1)
  })

  it('still restarts the subscription when the host answers with a replacement runtime', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    expect(activeTabsSubscriptions()).toHaveLength(1)

    await act(async () => {
      setRuntimeStatusEntry({
        status: { runtimeId: 'runtime-b' },
        snapshot: {
          ...verifiedSnapshot(),
          sequence: 2,
          checkedAt: 2,
          status: { runtimeId: 'runtime-b' } as RuntimeHostStatusSnapshot['status']
        },
        connectionGeneration: 1
      })
      await settle()
    })

    expect(activeTabsSubscriptions()).toHaveLength(2)
  })
})
