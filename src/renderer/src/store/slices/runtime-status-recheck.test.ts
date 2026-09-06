import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { toast } from 'sonner'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../../shared/protocol-version'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  createRuntimeStatusSlice,
  setRuntimeEnvironmentConnectionGenerationForTests,
  type RuntimeStatusSlice
} from './runtime-status'
import { clearRuntimeStatusRechecksForTests } from './runtime-status-recheck'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

beforeEach(() => {
  vi.useFakeTimers()
  clearRuntimeStatusRechecksForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  vi.mocked(toast.warning).mockReset()
})

afterEach(() => {
  clearRuntimeStatusRechecksForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runtime status recheck', () => {
  it('publishes an observe-only ready result through the setter', async () => {
    const getStatus = vi.fn().mockResolvedValue(response(status('ready')))
    const store = createStore(getStatus)

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready'),
      checkedAt: 1
    })
    await vi.advanceTimersByTimeAsync(3_000)

    expect(getStatus).toHaveBeenCalledWith({
      selector: 'env-a',
      timeoutMs: 10_000,
      observeOnly: true
    })
    expect(
      store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.remoteControl
    ).toMatchObject({
      state: 'ready'
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(getStatus).toHaveBeenCalledOnce()
  })

  it('continues indefinitely on the capped ladder, including unchanged publishes', async () => {
    const getStatus = vi.fn().mockResolvedValue(response(status('reconnecting')))
    const store = createStore(getStatus)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('reconnecting'),
      checkedAt: 1
    })

    await vi.advanceTimersByTimeAsync(3_000 + 6_000 + 12_000 + 30_000 + 60_000 + 60_000)

    expect(getStatus).toHaveBeenCalledTimes(6)
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.checkedAt).toBe(1)
  })

  it('cancels on removal, capability loss, and null without probing again', async () => {
    const getStatus = vi.fn()
    const store = createStore(getStatus)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_authenticated'),
      checkedAt: 1
    })
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: { ...status('awaiting_authenticated'), capabilities: [] },
      checkedAt: 2
    })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getStatus).not.toHaveBeenCalled()

    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready'),
      checkedAt: 3
    })
    store.getState().setRuntimeEnvironments([])
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getStatus).not.toHaveBeenCalled()
  })

  it('cancels an armed probe when the connection generation changes', async () => {
    const getStatus = vi.fn()
    const store = createStore(getStatus)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready'),
      checkedAt: 1
    })

    setRuntimeEnvironmentConnectionGenerationForTests('env-a', 2)
    await vi.advanceTimersByTimeAsync(3_000)

    expect(getStatus).not.toHaveBeenCalled()
  })

  it('restarts the ladder for a newly published connection generation', async () => {
    const getStatus = vi.fn().mockResolvedValue(response(status('ready', 'rt-next')))
    const store = createStore(getStatus)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready'),
      checkedAt: 1
    })
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready', 'rt-next'),
      checkedAt: 2
    })

    await vi.advanceTimersByTimeAsync(3_000)

    expect(getStatus).toHaveBeenCalledOnce()
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.runtimeId).toBe(
      'rt-next'
    )
  })

  it('discards an in-flight result after a ready publish bumps the epoch', async () => {
    const pending = deferred<ReturnType<typeof response>>()
    const getStatus = vi.fn().mockReturnValue(pending.promise)
    const store = createStore(getStatus)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready'),
      checkedAt: 1
    })
    await vi.advanceTimersByTimeAsync(3_000)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('ready'),
      checkedAt: 2
    })

    pending.resolve(response(status('reconnecting')))
    await Promise.resolve()
    await Promise.resolve()

    expect(
      store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.remoteControl
    ).toMatchObject({
      state: 'ready'
    })
  })

  it('keeps setter side effects when a recheck discovers disconnection', async () => {
    const getStatus = vi.fn().mockResolvedValue({
      id: 'status.get',
      ok: false,
      error: {
        code: 'runtime_unavailable',
        message: 'offline',
        data: { remoteControl: status('reconnecting').remoteControl }
      },
      _meta: { runtimeId: 'rt' }
    })
    const store = createStore(getStatus)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready'),
      checkedAt: 1
    })

    await vi.advanceTimersByTimeAsync(3_000)

    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBeNull()
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.remoteControl).toMatchObject(
      {
        state: 'reconnecting'
      }
    )
    expect(toast.warning).toHaveBeenCalledOnce()
  })
})

function createStore(getStatus: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('window', {
    api: { runtimeEnvironments: { getStatus, list: vi.fn() } }
  })
  const store = create<RuntimeStatusSlice>()((...args) => ({
    ...createRuntimeStatusSlice(...(args as unknown as Parameters<typeof createRuntimeStatusSlice>))
  }))
  store.getState().setRuntimeEnvironments([environment()])
  return store
}

function status(
  controlState: NonNullable<RuntimeStatus['remoteControl']>['state'],
  runtimeId = 'rt'
): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY],
    remoteControl: {
      state: controlState,
      pendingRequestCount: 0,
      subscriptionCount: 0,
      reconnectAttempt: 1,
      lastConnectedAt: null,
      lastClose: null,
      lastError: null
    }
  } as RuntimeStatus
}

function response(result: RuntimeStatus) {
  return { id: 'status.get', ok: true as const, result, _meta: { runtimeId: result.runtimeId } }
}

function environment(): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-a',
    name: 'Dev Box',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: 'rt',
    endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
    preferredEndpointId: 'ws'
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
