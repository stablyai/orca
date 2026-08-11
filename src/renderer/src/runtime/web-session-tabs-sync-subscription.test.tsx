// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { Repo } from '../../../shared/types'
import { useAppStore } from '../store'
import { makeWorktree } from '../store/slices/store-test-helpers'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'

const ENVIRONMENT_ID = 'remote-env'
const RUNTIME_ID = 'remote-runtime'
const REPO_ID = 'remote-repo'
const WORKTREE_ID = `${REPO_ID}::/remote/worktree`
const PAIRING_REVISION = 17
const initialState = useAppStore.getInitialState()
type RuntimeSubscribeCallbacks = Parameters<typeof window.api.runtimeEnvironments.subscribe>[1]

function environment(): PublicKnownRuntimeEnvironment {
  return {
    id: ENVIRONMENT_ID,
    name: 'Remote host',
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: PAIRING_REVISION,
    lastUsedAt: null,
    runtimeId: RUNTIME_ID,
    endpoints: [
      {
        id: 'remote-endpoint',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://remote.invalid'
      }
    ],
    preferredEndpointId: 'remote-endpoint'
  }
}

function runtimeStatus(): RuntimeStatus {
  return {
    runtimeId: RUNTIME_ID,
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

function repo(): Repo {
  return {
    id: REPO_ID,
    path: '/remote/repo',
    displayName: 'Remote repo',
    badgeColor: '#000',
    addedAt: 1,
    connectionId: null,
    executionHostId: `runtime:${ENVIRONMENT_ID}`
  }
}

function worktree() {
  return makeWorktree({
    id: WORKTREE_ID,
    repoId: REPO_ID,
    path: '/remote/worktree',
    hostId: `runtime:${ENVIRONMENT_ID}`,
    runtimeOwnerEnvironmentId: ENVIRONMENT_ID
  })
}

function seedRemoteWorkspace(): void {
  const remoteEnvironment = environment()
  replaceRuntimeEnvironmentRevisions([remoteEnvironment])
  useAppStore.setState(
    {
      ...initialState,
      settings: {
        ...getDefaultSettings('/tmp'),
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      repos: [repo()],
      worktreesByRepo: { [REPO_ID]: [worktree()] },
      activeRepoId: REPO_ID,
      activeWorktreeId: WORKTREE_ID,
      activeWorkspaceExecutionHostId: `runtime:${ENVIRONMENT_ID}`,
      runtimeEnvironments: [remoteEnvironment],
      runtimeStatusByEnvironmentId: new Map([
        [
          ENVIRONMENT_ID,
          {
            status: runtimeStatus(),
            checkedAt: 1,
            connectionGeneration: 3
          }
        ]
      ]),
      workspaceSessionReady: true
    },
    true
  )
}

function response(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'subscribe-all', ok: true, result, _meta: { runtimeId: RUNTIME_ID } }
}

describe('useWebSessionTabsSync subscription topology', () => {
  const globalUnsubscribe = vi.fn()
  const activeUnsubscribe = vi.fn()
  const runtimeCall = vi.fn()
  const runtimeSubscribe = vi.fn()
  let globalCallbacks: RuntimeSubscribeCallbacks | undefined

  beforeEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
    globalUnsubscribe.mockReset()
    activeUnsubscribe.mockReset()
    runtimeCall.mockReset()
    runtimeSubscribe.mockReset()
    globalCallbacks = undefined
    runtimeCall.mockResolvedValue({
      id: 'list-all',
      ok: true,
      result: { snapshots: [] },
      _meta: { runtimeId: RUNTIME_ID }
    })
    runtimeSubscribe.mockImplementation(
      async (args: { method: string }, callbacks: RuntimeSubscribeCallbacks) => {
        if (args.method === 'session.tabs.subscribeAll') {
          globalCallbacks = callbacks
        }
        return {
          unsubscribe:
            args.method === 'session.tabs.subscribeAll' ? globalUnsubscribe : activeUnsubscribe,
          sendBinary: vi.fn()
        }
      }
    )
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtimeEnvironments: {
          call: runtimeCall,
          subscribe: runtimeSubscribe
        }
      }
    })
    seedRemoteWorkspace()
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
  })

  it('hydrates through subscribeAll without an eager listAll request', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())

    await waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    expect(runtimeSubscribe.mock.calls.map(([args]) => args)).toEqual(
      expect.arrayContaining([
        {
          selector: ENVIRONMENT_ID,
          method: 'session.tabs.subscribeAll',
          params: {},
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: PAIRING_REVISION
        },
        {
          selector: ENVIRONMENT_ID,
          method: 'session.tabs.subscribe',
          params: { worktree: `id:${WORKTREE_ID}` },
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: PAIRING_REVISION
        }
      ])
    )
    expect(runtimeCall).not.toHaveBeenCalled()

    hook.unmount()
    expect(globalUnsubscribe).toHaveBeenCalledTimes(1)
    expect(activeUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('falls back to one listAll request when subscribeAll cannot start', async () => {
    let rejectGlobalSubscription: (error: Error) => void = () => {}
    const globalSubscription = new Promise<never>((_resolve, reject) => {
      rejectGlobalSubscription = reject
    })
    runtimeSubscribe.mockImplementation(async (args: { method: string }) => {
      if (args.method === 'session.tabs.subscribeAll') {
        return globalSubscription
      }
      return { unsubscribe: activeUnsubscribe, sendBinary: vi.fn() }
    })

    const hook = renderHook(() => useWebSessionTabsSync())

    await waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    expect(runtimeCall).not.toHaveBeenCalled()
    rejectGlobalSubscription(new Error('shared-control unavailable'))
    await waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.listAll',
      params: {},
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: PAIRING_REVISION
    })

    hook.unmount()
    expect(globalUnsubscribe).not.toHaveBeenCalled()
    expect(activeUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('once-gates fallback across invalid and failed pre-initial stream events', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())

    await waitFor(() => expect(globalCallbacks).toBeDefined())
    expect(() => globalCallbacks?.onResponse(response(null))).not.toThrow()
    globalCallbacks?.onResponse({
      id: 'subscribe-all',
      ok: false,
      error: { code: 'method_not_found', message: 'missing' }
    })
    globalCallbacks?.onError?.({ code: 'transport_closed', message: 'closed' })
    globalCallbacks?.onClose?.()

    await waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    hook.unmount()
  })

  it('does not fall back after a valid initial snapshot batch', async () => {
    const hook = renderHook(() => useWebSessionTabsSync())

    await waitFor(() => expect(globalCallbacks).toBeDefined())
    globalCallbacks?.onResponse(response({ type: 'snapshots', snapshots: [] }))
    globalCallbacks?.onError?.({ code: 'transport_closed', message: 'closed' })
    globalCallbacks?.onClose?.()

    await waitFor(() => expect(runtimeSubscribe).toHaveBeenCalledTimes(2))
    expect(runtimeCall).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('falls back when a started stream never sends its initial batch', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useWebSessionTabsSync())
      await act(async () => {})

      expect(runtimeSubscribe).toHaveBeenCalledTimes(2)
      expect(runtimeCall).not.toHaveBeenCalled()
      await act(async () => vi.advanceTimersByTimeAsync(15_000))
      expect(runtimeCall).toHaveBeenCalledTimes(1)

      hook.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
