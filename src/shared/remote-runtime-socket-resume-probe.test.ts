import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  probeAllRemoteRuntimeSocketsNow,
  startRemoteRuntimeSocketLiveness
} from './remote-runtime-socket-liveness'
import { SharedControlReconnectScheduler } from './remote-runtime/control/remote-runtime-shared-control-reconnect'

// Regression for #9092: after sleep a socket can still read OPEN while its path is gone, so resume
// probes every socket at once. A miss at the probe deadline marks it suspect and re-pings; only the
// normal 25 s keepalive window kills it, because relayed links can take longer than 8 s to reroute.
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
    const monitor = startRemoteRuntimeSocketLiveness({ ping, onDead })
    monitors.push(monitor)
    return { monitor, onDead, ping }
  }

  it('keeps a socket that answers the wake probe 12 s late', async () => {
    const { monitor, onDead, ping } = start()

    probeAllRemoteRuntimeSocketsNow()
    await vi.advanceTimersByTimeAsync(8_000)
    expect(ping).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)
    monitor.noteActivity()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(onDead).not.toHaveBeenCalled()
  })

  it('declares a silent socket dead when the normal keepalive window ends', async () => {
    const { onDead } = start()

    expect(probeAllRemoteRuntimeSocketsNow()).toBe(1)
    await vi.advanceTimersByTimeAsync(24_999)
    expect(onDead).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(onDead).toHaveBeenCalledExactlyOnceWith('wake_probe_timeout')
  })

  it('measures round trips from the oldest unanswered ping', async () => {
    const onRoundTrip = vi.fn()
    const monitor = startRemoteRuntimeSocketLiveness({
      ping: () => true,
      onDead: vi.fn(),
      onRoundTrip
    })
    monitors.push(monitor)

    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(350)
    monitor.notePong()
    monitor.notePong()
    expect(onRoundTrip).toHaveBeenCalledExactlyOnceWith(350)

    // A ping left unanswered through a network change is not timed against the probe's pong.
    await vi.advanceTimersByTimeAsync(10_000)
    await vi.advanceTimersByTimeAsync(5_000)
    probeAllRemoteRuntimeSocketsNow()
    await vi.advanceTimersByTimeAsync(200)
    monitor.notePong()
    expect(onRoundTrip).toHaveBeenLastCalledWith(200)
  })

  it('gives a network-change probe a full window even with an older keepalive unanswered', async () => {
    const { monitor, onDead } = start()

    await vi.advanceTimersByTimeAsync(29_000)
    probeAllRemoteRuntimeSocketsNow()
    await vi.advanceTimersByTimeAsync(12_000)
    expect(onDead).not.toHaveBeenCalled()
    monitor.noteActivity()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(onDead).not.toHaveBeenCalled()
  })

  it('skips the probe when data arrived in the last few seconds', async () => {
    const { monitor, onDead, ping } = start()

    monitor.noteActivity()
    await vi.advanceTimersByTimeAsync(2_000)
    probeAllRemoteRuntimeSocketsNow()
    expect(ping).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(7_000)
    expect(onDead).not.toHaveBeenCalled()

    probeAllRemoteRuntimeSocketsNow()
    expect(ping).toHaveBeenCalledTimes(1)
  })

  it('probes afresh instead of failing a socket when the process stalled through the deadline', async () => {
    let clock = 0
    const onDead = vi.fn()
    const ping = vi.fn(() => true)
    monitors.push(
      startRemoteRuntimeSocketLiveness({
        ping,
        onDead,
        now: () => clock,
        options: { pingIntervalMs: 60_000, livenessTimeoutMs: 120_000 }
      })
    )

    probeAllRemoteRuntimeSocketsNow(2_000)
    clock += 20_000
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onDead).not.toHaveBeenCalled()
    expect(ping).toHaveBeenCalledTimes(2)

    // The fresh probe still ends a socket that stays silent.
    for (let elapsed = 0; elapsed < 120_000; elapsed += 1_000) {
      clock += 1_000
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('skips stopped monitors and coalesces a repeated resume into one probe', async () => {
    const stopped = start()
    stopped.monitor.stop()
    const live = start()

    expect(probeAllRemoteRuntimeSocketsNow(2_000)).toBe(1)
    probeAllRemoteRuntimeSocketsNow(2_000)
    expect(stopped.ping).not.toHaveBeenCalled()
    expect(live.ping).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(live.onDead).toHaveBeenCalledTimes(1)
    expect(stopped.onDead).not.toHaveBeenCalled()
  })

  it('does not arm a deadline for a socket that is still connecting', async () => {
    let open = false
    const ping = vi.fn(() => open)
    const { onDead } = start(vi.fn(), ping)

    probeAllRemoteRuntimeSocketsNow(2_000)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(onDead).not.toHaveBeenCalled()

    // Once open, the next resume probes it normally.
    open = true
    probeAllRemoteRuntimeSocketsNow(2_000)
    await vi.advanceTimersByTimeAsync(25_000)
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
