import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isRemoteRuntimeLivenessTickDelayed,
  startRemoteRuntimeSocketLiveness
} from './remote-runtime-socket-liveness'

describe('remote runtime socket liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('re-baselines after a suspended tick before judging socket death', async () => {
    let now = 1_000
    const ping = vi.fn()
    const onDead = vi.fn()
    const monitor = startRemoteRuntimeSocketLiveness({
      ping,
      onDead,
      options: { pingIntervalMs: 100, livenessTimeoutMs: 250 },
      now: () => now
    })

    now += 3_600_000
    await vi.advanceTimersByTimeAsync(100)

    expect(onDead).not.toHaveBeenCalled()
    expect(ping).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('kills only after a fresh sent probe gets its full unanswered window', async () => {
    let now = 1_000
    const ping = vi.fn()
    const onDead = vi.fn()
    startRemoteRuntimeSocketLiveness({
      ping,
      onDead,
      options: { pingIntervalMs: 100, livenessTimeoutMs: 250 },
      now: () => now
    })

    for (const delta of [100, 100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(ping).toHaveBeenCalledTimes(1)
    expect(onDead).not.toHaveBeenCalled()

    for (const delta of [100, 100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('clears an outstanding probe after inbound activity', async () => {
    let now = 1_000
    const ping = vi.fn()
    const onDead = vi.fn()
    const monitor = startRemoteRuntimeSocketLiveness({
      ping,
      onDead,
      options: { pingIntervalMs: 100, livenessTimeoutMs: 250 },
      now: () => now
    })

    for (const delta of [100, 100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(ping).toHaveBeenCalledTimes(1)

    monitor.noteActivity()
    for (const delta of [100, 100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }

    expect(ping).toHaveBeenCalledTimes(2)
    expect(onDead).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('re-baselines after a backward clock jump rather than killing', async () => {
    let now = 1_000
    const ping = vi.fn()
    const onDead = vi.fn()
    const monitor = startRemoteRuntimeSocketLiveness({
      ping,
      onDead,
      options: { pingIntervalMs: 100, livenessTimeoutMs: 250 },
      now: () => now
    })

    for (const delta of [100, 100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(ping).toHaveBeenCalledTimes(1)

    now = 500
    await vi.advanceTimersByTimeAsync(100)
    expect(onDead).not.toHaveBeenCalled()

    for (const delta of [100, 100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(ping).toHaveBeenCalledTimes(2)
    expect(onDead).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('stops idempotently', () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const monitor = startRemoteRuntimeSocketLiveness({
      ping: vi.fn(),
      onDead: vi.fn(),
      options: { pingIntervalMs: 100, livenessTimeoutMs: 250 }
    })

    monitor.stop()
    monitor.stop()

    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('calls onDead exactly once', async () => {
    let now = 1_000
    const onDead = vi.fn()
    startRemoteRuntimeSocketLiveness({
      ping: vi.fn(),
      onDead,
      options: { pingIntervalMs: 100, livenessTimeoutMs: 250 },
      now: () => now
    })

    for (let tick = 0; tick < 10; tick += 1) {
      now += 100
      await vi.advanceTimersByTimeAsync(100)
    }

    expect(onDead).toHaveBeenCalledTimes(1)
  })

  it('detects delayed and backward liveness ticks', () => {
    expect(
      isRemoteRuntimeLivenessTickDelayed({ now: 1_199, lastTickAt: 1_000, intervalMs: 100 })
    ).toBe(false)
    expect(
      isRemoteRuntimeLivenessTickDelayed({ now: 1_200, lastTickAt: 1_000, intervalMs: 100 })
    ).toBe(true)
    expect(
      isRemoteRuntimeLivenessTickDelayed({ now: 999, lastTickAt: 1_000, intervalMs: 100 })
    ).toBe(true)
  })
})
