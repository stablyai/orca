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

  it('cancels on removal and capability loss without probing again', async () => {
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

  it('re-probes a host recorded unreachable until it answers again', async () => {
    // A boot probe that failed while the host was asleep must not outlive the outage:
    // nothing else re-asks, because the client-event subscription set is gated on a truthy status.
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce(unavailableResponse())
      .mockResolvedValue(response(status('ready')))
    const store = createStore(getStatus)

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(getStatus).toHaveBeenCalledWith({
      selector: 'env-a',
      timeoutMs: 10_000,
      observeOnly: true
    })
    expect(store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status).toBeNull()

    await vi.advanceTimersByTimeAsync(6_000)
    expect(
      store.getState().runtimeStatusByEnvironmentId.get('env-a')?.status?.remoteControl
    ).toMatchObject({ state: 'ready' })

    const callsAtRecovery = getStatus.mock.calls.length
    await vi.advanceTimersByTimeAsync(300_000)
    expect(getStatus).toHaveBeenCalledTimes(callsAtRecovery)
  })

  it('does not re-toast while the ladder keeps confirming the same outage', async () => {
    // The ladder republishes null on every failed retry; only a real truthy -> null
    // transition is news, so the warning must not pop once per retry.
    const getStatus = vi.fn().mockResolvedValue(unavailableResponse())
    const store = createStore(getStatus)

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })
    await vi.advanceTimersByTimeAsync(3_000 + 6_000 + 12_000 + 30_000)

    expect(getStatus).toHaveBeenCalledTimes(4)
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('stops re-probing a manually disconnected host', async () => {
    // The probe short-circuits locally for these, so retrying only burns a timer forever.
    const getStatus = vi.fn().mockResolvedValue({
      id: 'runtime.manualDisconnect',
      ok: false,
      error: {
        code: 'runtime_manually_disconnected',
        message: 'Runtime environment is manually disconnected.'
      },
      _meta: { runtimeId: 'rt' }
    })
    const store = createStore(getStatus)

    store.getState().setRuntimeEnvironmentStatus('env-a', { status: null, checkedAt: 1 })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(getStatus).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(getStatus).toHaveBeenCalledOnce()
  })

  it('preserves a live verdict when an unverifiable probe cannot reach the host (#19647)', async () => {
    // A failed status.get dials its own fresh socket, so its runtime_unavailable answer is
    // unverifiable — the client could not ask. Nulling the recorded live status here would drop
    // the environment out of the session-tabs mirror targets and dim its sidebar rows even though
    // its established flows are still delivering. The verdict must survive; only its diagnostics
    // are refreshed to reconnecting so the ladder keeps probing.
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

    const entry = store.getState().runtimeStatusByEnvironmentId.get('env-a')
    expect(entry?.status).not.toBeNull()
    expect(entry?.status?.remoteControl).toMatchObject({ state: 'reconnecting' })
    // No truthy -> null transition, so the disconnect toast must not fire on an unverifiable probe.
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('does not advance the connection generation when recovering from an unverifiable probe (#19647)', async () => {
    // The double-teardown: nulling a live status retires the mirror once, and the null -> truthy
    // recovery advances the connection generation, rebuilding it a second time. Preserving the
    // verdict across the outage keeps the generation stable, so recovery is not a reconnect.
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'status.get',
        ok: false,
        error: {
          code: 'runtime_unavailable',
          message: 'offline',
          data: { remoteControl: status('reconnecting').remoteControl }
        },
        _meta: { runtimeId: 'rt' }
      })
      .mockResolvedValue(response(status('ready')))
    const store = createStore(getStatus)
    store.getState().setRuntimeEnvironmentStatus('env-a', {
      status: status('awaiting_ready'),
      checkedAt: 1
    })
    const generationBefore = store
      .getState()
      .runtimeStatusByEnvironmentId.get('env-a')?.connectionGeneration

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(6_000)

    const entry = store.getState().runtimeStatusByEnvironmentId.get('env-a')
    expect(entry?.status?.remoteControl).toMatchObject({ state: 'ready' })
    expect(entry?.connectionGeneration).toBe(generationBefore)
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

function unavailableResponse() {
  return {
    id: 'status.get',
    ok: false as const,
    error: { code: 'runtime_unavailable', message: 'offline' },
    _meta: { runtimeId: 'rt' }
  }
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
