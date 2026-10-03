import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  probeAllRemoteRuntimeSocketsNow,
  startRemoteRuntimeSocketLiveness
} from './remote-runtime-socket-liveness'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'

// Regression for #9092: after sleep a socket can still read OPEN while its path is gone, and the
// normal cadence took ~30-40 s to notice; resume now probes every socket with a short deadline.
describe('remote runtime resume probe', () => {
  const monitors: { stop: () => void }[] = []

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    for (const monitor of monitors.splice(0)) {
      monitor.stop()
    }
    vi.useRealTimers()
  })

  function start(onDead = vi.fn(), ping = vi.fn(() => true)) {
    const monitor = startRemoteRuntimeSocketLiveness({
      ping,
      onDead,
      options: { pingIntervalMs: 10_000, livenessTimeoutMs: 25_000 }
    })
    monitors.push(monitor)
    return { monitor, onDead, ping }
  }

  it('declares a silent socket dead within the resume deadline', async () => {
    const { onDead, ping } = start()

    expect(probeAllRemoteRuntimeSocketsNow(2_000)).toBe(1)
    expect(ping).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(onDead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('keeps a socket that answers the probe', async () => {
    const { monitor, onDead } = start()

    probeAllRemoteRuntimeSocketsNow(2_000)
    await vi.advanceTimersByTimeAsync(500)
    monitor.noteActivity()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onDead).not.toHaveBeenCalled()
  })

  it('skips stopped monitors and coalesces a repeated resume into one probe', async () => {
    const stopped = start()
    stopped.monitor.stop()
    const live = start()

    expect(probeAllRemoteRuntimeSocketsNow(2_000)).toBe(1)
    probeAllRemoteRuntimeSocketsNow(2_000)
    expect(stopped.ping).not.toHaveBeenCalled()
    expect(live.ping).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(live.onDead).toHaveBeenCalledTimes(1)
    expect(stopped.onDead).not.toHaveBeenCalled()
  })

  it('does not arm a deadline for a socket that is still connecting', async () => {
    let open = false
    const ping = vi.fn(() => open)
    const { onDead } = start(vi.fn(), ping)

    probeAllRemoteRuntimeSocketsNow(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onDead).not.toHaveBeenCalled()

    // Once open, the next resume probes it normally.
    open = true
    probeAllRemoteRuntimeSocketsNow(2_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onDead).toHaveBeenCalledTimes(1)
  })
})

describe('SharedControlReconnectScheduler.retryNow after an outage', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('restarts the backoff ladder so a failure right after wake retries quickly', () => {
    const scheduler = new SharedControlReconnectScheduler()
    const open = vi.fn()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      scheduler.scheduleWithIdleBackoff(false, open)
      vi.runOnlyPendingTimers()
    }
    expect(scheduler.attemptCount).toBeGreaterThanOrEqual(6)

    scheduler.scheduleWithIdleBackoff(false, open)
    expect(scheduler.retryNow()).toBe(true)
    expect(scheduler.attemptCount).toBe(0)
  })

  it('restarts the ladder even when the wake lands while a reconnect is already opening', () => {
    const scheduler = new SharedControlReconnectScheduler()
    const open = vi.fn()
    for (let attempt = 0; attempt < 6; attempt += 1) {
      scheduler.scheduleWithIdleBackoff(false, open)
      vi.runOnlyPendingTimers()
    }
    // The last open() is in flight, so no timer is pending for retryNow to advance.
    expect(scheduler.isScheduled).toBe(false)
    expect(scheduler.retryNow()).toBe(false)
    expect(scheduler.attemptCount).toBe(0)
  })

  it('does nothing when no reconnect is pending', () => {
    const scheduler = new SharedControlReconnectScheduler()
    expect(scheduler.retryNow()).toBe(false)
    expect(scheduler.attemptCount).toBe(0)
  })
})
