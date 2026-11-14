import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RemoteRuntimePtyRecoveryState,
  retryAllRemoteRuntimePtyRecoveriesNow
} from './remote-runtime-pty-recovery-state'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from './remote-runtime-pty-recovery-limits'

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteRuntimePtyRecoveryState', () => {
  it('does not leave a timer armed when onChange forces the retry synchronously', async () => {
    vi.useFakeTimers()
    const retry = vi.fn()
    let state: RemoteRuntimePtyRecoveryState
    state = new RemoteRuntimePtyRecoveryState(() => {
      if (state.currentPhase === 'backoff') {
        retryAllRemoteRuntimePtyRecoveriesNow()
      }
    })
    const epoch = state.begin()

    state.schedule(epoch, retry)
    await vi.advanceTimersByTimeAsync(30_000)

    expect(retry).toHaveBeenCalledTimes(1)
    state.dispose()
  })

  it.each(['healthy', 'cancelled', 'disposed', 'deadline', 'exhausted', 'contact loss'] as const)(
    'settles the owner caller once and retains only the allowance owned by %s',
    async (finish) => {
      vi.useFakeTimers()
      const state = new RemoteRuntimePtyRecoveryState()
      const epoch = state.begin()
      const retry = vi.fn()
      const claim = state.claimOwnerRefresh(epoch, retry)
      const settled = vi.fn()
      void claim?.promise.then(settled)
      expect(state.claimOwnerRefresh(epoch, retry)).toEqual({
        started: false,
        promise: claim?.promise
      })
      const result = { id: 'owner', replay: '', isReattach: true }
      await {
        healthy: () => state.markHealthy(result),
        cancelled: () => state.cancel(),
        disposed: () => state.dispose(),
        exhausted: () => state.markDisconnected(),
        'contact loss': () => state.parkOwnerRefresh(epoch),
        deadline: () => vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)
      }[finish]()
      expect(await claim?.promise).toEqual(finish === 'healthy' ? result : undefined)
      if (finish === 'deadline' || finish === 'exhausted' || finish === 'contact loss') {
        expect(state.hasOwnerRefresh).toBe(true)
        expect(state.retryNow()).toBe(true)
        const nextEpoch = finish === 'contact loss' ? epoch : epoch + 1
        expect(retry).toHaveBeenCalledExactlyOnceWith(nextEpoch)
        expect(state.claimOwnerRefresh(nextEpoch, retry)?.started).toBe(finish !== 'contact loss')
      } else {
        expect(state.hasOwnerRefresh).toBe(false)
        expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(0)
      }
      state.dispose()
      await Promise.resolve()
      expect(settled).toHaveBeenCalledOnce()
    }
  )

  it('keeps a timed-out pane revivable through the scheduled recovery registry', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const firstEpoch = state.begin()
    // Why: the backoff ladder outlasts the recovery window, so a retry is still armed when the cutoff lands.
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS - 100)
    state.schedule(firstEpoch, retry)

    await vi.advanceTimersByTimeAsync(100)
    expect(state.currentPhase).toBe('disconnected')

    await vi.advanceTimersByTimeAsync(300_000)
    expect(retry).not.toHaveBeenCalled()

    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
    expect(retry).toHaveBeenCalledWith(firstEpoch + 1)
    expect(state.currentPhase).toBe('recovering')
    state.dispose()
  })

  it('fires a parked retry while still recovering, in the same epoch', () => {
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const epoch = state.begin()
    expect(state.parkRetryForExternalTrigger(epoch, retry)).toBe(true)

    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
    expect(retry).toHaveBeenCalledWith(epoch)
    expect(state.currentPhase).toBe('recovering')
    expect(state.retryNow()).toBe(false)
    state.dispose()
  })

  // #12683: markDisconnected() is a UI latch, not proof the window ran out.
  it('only reports the auto-recovery window spent when the deadline actually fired', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const epoch = state.begin()
    state.schedule(epoch, vi.fn())

    state.markDisconnected()
    expect(state.currentPhase).toBe('disconnected')
    expect(state.autoRecoveryDeadlineExpired).toBe(false)

    const secondEpoch = state.begin()
    state.schedule(secondEpoch, vi.fn())
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS)

    expect(state.currentPhase).toBe('disconnected')
    expect(state.autoRecoveryDeadlineExpired).toBe(true)

    state.markHealthy()
    expect(state.autoRecoveryDeadlineExpired).toBe(false)
    state.dispose()
  })
})
