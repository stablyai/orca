import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startRemoteRuntimeSocketLiveness } from './remote-runtime-socket-liveness'

describe('remote runtime socket liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('grants a fresh probe window after a suspended client resumes', async () => {
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

    expect(ping).toHaveBeenCalledTimes(1)
    expect(onDead).not.toHaveBeenCalled()

    for (const delta of [100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(onDead).not.toHaveBeenCalled()

    now += 100
    await vi.advanceTimersByTimeAsync(100)
    expect(onDead).toHaveBeenCalledTimes(1)
    monitor.stop()
  })

  it('clears the resumed probe when the socket answers', async () => {
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
    monitor.noteActivity()
    for (const delta of [100, 100, 100]) {
      now += delta
      await vi.advanceTimersByTimeAsync(100)
    }

    expect(onDead).not.toHaveBeenCalled()
    monitor.stop()
  })
})
