import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimePtyRecoveryState } from './remote-runtime-pty-recovery-state'

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
})
