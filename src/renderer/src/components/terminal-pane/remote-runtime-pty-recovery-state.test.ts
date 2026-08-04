import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS,
  RemoteRuntimePtyRecoveryState,
  retryAllRemoteRuntimePtyRecoveriesNow
} from './remote-runtime-pty-recovery-state'

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteRuntimePtyRecoveryState', () => {
  it('cancels stale retry timers when a pane detaches', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const epoch = state.begin()
    state.schedule(epoch, retry)

    state.cancel()
    await vi.runAllTimersAsync()

    expect(retry).not.toHaveBeenCalled()
    expect(state.isCurrent(epoch)).toBe(false)
    expect(state.isActive).toBe(false)
  })

  it('keeps one epoch across retries and rejects it after disposal', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const epoch = state.begin()
    state.schedule(epoch, retry)

    await vi.advanceTimersByTimeAsync(250)
    expect(retry).toHaveBeenCalledWith(epoch)
    expect(state.begin()).toBe(epoch)

    state.dispose()
    expect(state.isCurrent(epoch)).toBe(false)
    expect(state.isActive).toBe(false)
  })

  it('rejects a stale retry after a newer attachment becomes healthy', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const epoch = state.begin()

    state.markHealthy()

    expect(state.isCurrent(epoch)).toBe(false)
    expect(state.schedule(epoch, retry)).toBe(false)
    await vi.runAllTimersAsync()
    expect(retry).not.toHaveBeenCalled()
  })

  it('stops automatic recovery after the bounded recovery window', async () => {
    vi.useFakeTimers()
    const onChange = vi.fn()
    const state = new RemoteRuntimePtyRecoveryState(onChange)
    const retry = vi.fn()
    const epoch = state.begin()
    state.schedule(epoch, retry)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(state.currentPhase).toBe('disconnected')
    expect(state.isActive).toBe(false)
    expect(state.isCurrent(epoch)).toBe(false)
    expect(onChange).toHaveBeenCalled()
    state.dispose()
  })

  it('advances a pending backoff immediately via retryNow and the active registry', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const epoch = state.begin()
    state.schedule(epoch, retry)

    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(0)
    expect(retry).toHaveBeenCalledWith(epoch)
    expect(state.currentPhase).toBe('recovering')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(retry).toHaveBeenCalledTimes(1)
    state.dispose()
  })

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

  it('starts a newly fenced recovery epoch after a manual retry', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const firstEpoch = state.begin()

    await vi.advanceTimersByTimeAsync(60_000)
    const manualEpoch = state.begin()

    expect(manualEpoch).toBe(firstEpoch + 1)
    expect(state.currentPhase).toBe('recovering')
    expect(state.isCurrent(firstEpoch)).toBe(false)
    expect(state.isCurrent(manualEpoch)).toBe(true)
    state.dispose()
  })

  it('cancels scheduled work when a caller reaches its own recovery cutoff', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const epoch = state.begin()
    state.schedule(epoch, retry)

    state.markDisconnected()
    await vi.runAllTimersAsync()

    expect(state.currentPhase).toBe('disconnected')
    expect(state.isCurrent(epoch)).toBe(false)
    expect(retry).not.toHaveBeenCalled()
  })

  it.each([
    ['healthy', (state: RemoteRuntimePtyRecoveryState) => state.markHealthy()],
    ['disconnected', (state: RemoteRuntimePtyRecoveryState) => state.markDisconnected()],
    ['cancelled', (state: RemoteRuntimePtyRecoveryState) => state.cancel()],
    ['disposed', (state: RemoteRuntimePtyRecoveryState) => state.dispose()]
  ])('removes %s panes from the scheduled recovery registry', (_label, finish) => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const epoch = state.begin()
    state.schedule(epoch, vi.fn())
    const retryNow = vi.spyOn(state, 'retryNow')

    finish(state)
    retryAllRemoteRuntimePtyRecoveriesNow()

    expect(retryNow).not.toHaveBeenCalled()
  })

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

  it('revives a parked retry that never armed a backoff timer', async () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const retry = vi.fn()
    const firstEpoch = state.begin()
    expect(state.parkRetryForExternalTrigger(firstEpoch, retry)).toBe(true)

    // Why: parking must not fire on its own, so the pane still latches at the cutoff.
    await vi.advanceTimersByTimeAsync(REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 300_000)
    expect(state.currentPhase).toBe('disconnected')
    expect(retry).not.toHaveBeenCalled()

    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(1)
    expect(retry).toHaveBeenCalledWith(firstEpoch + 1)
    expect(state.currentPhase).toBe('recovering')
    state.dispose()
  })

  it('refuses to park over an armed backoff or a stale epoch', () => {
    vi.useFakeTimers()
    const state = new RemoteRuntimePtyRecoveryState()
    const epoch = state.begin()
    state.schedule(epoch, vi.fn())

    expect(state.parkRetryForExternalTrigger(epoch, vi.fn())).toBe(false)

    state.cancel()
    expect(state.parkRetryForExternalTrigger(epoch, vi.fn())).toBe(false)
    expect(retryAllRemoteRuntimePtyRecoveriesNow()).toBe(0)
    state.dispose()
  })
})
