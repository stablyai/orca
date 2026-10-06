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

  describe('send probe', () => {
    const options = {
      pingIntervalMs: 60_000,
      livenessTimeoutMs: 60_000,
      sendProbeQuietMs: 2_000,
      sendProbeTimeoutMs: 5_000
    }

    function start(): {
      monitor: ReturnType<typeof startRemoteRuntimeSocketLiveness>
      ping: ReturnType<typeof vi.fn>
      onDead: ReturnType<typeof vi.fn>
      advance: (ms: number) => Promise<void>
    } {
      let now = 1_000
      const ping = vi.fn()
      const onDead = vi.fn()
      const monitor = startRemoteRuntimeSocketLiveness({ ping, onDead, options, now: () => now })
      return {
        monitor,
        ping,
        onDead,
        advance: async (ms) => {
          now += ms
          await vi.advanceTimersByTimeAsync(ms)
        }
      }
    }

    it('declares the socket dead when nothing arrives after a send, even if it was just busy', async () => {
      const { monitor, ping, onDead, advance } = start()
      // Inbound traffic right before the send must not exempt it from the probe.
      monitor.noteActivity()
      monitor.noteOutbound()

      await advance(1_999)
      expect(ping).not.toHaveBeenCalled()
      await advance(1)
      expect(ping).toHaveBeenCalledTimes(1)
      await advance(4_999)
      expect(onDead).not.toHaveBeenCalled()
      await advance(1)
      expect(onDead).toHaveBeenCalledTimes(1)
    })

    it('never pings when the reply arrives within the quiet window', async () => {
      const { monitor, ping, onDead, advance } = start()
      monitor.noteOutbound()
      await advance(500)
      monitor.noteActivity()
      await advance(20_000)
      expect(ping).not.toHaveBeenCalled()
      expect(onDead).not.toHaveBeenCalled()
      monitor.stop()
    })

    it('keeps the socket when any inbound traffic answers the probe', async () => {
      const { monitor, ping, onDead, advance } = start()
      monitor.noteOutbound()
      await advance(2_100)
      expect(ping).toHaveBeenCalledTimes(1)
      monitor.noteActivity()
      await advance(10_000)
      expect(onDead).not.toHaveBeenCalled()
      monitor.stop()
    })

    it('keeps at most one probe outstanding however many requests are sent', async () => {
      const { monitor, ping, advance } = start()
      for (let request = 0; request < 50; request += 1) {
        monitor.noteOutbound()
        await advance(50)
      }
      await advance(1_000)
      expect(ping).toHaveBeenCalledTimes(1)
      monitor.stop()
    })

    it('re-probes instead of declaring death when the deadline fired late after a suspend', async () => {
      let now = 1_000
      const ping = vi.fn()
      const onDead = vi.fn()
      const monitor = startRemoteRuntimeSocketLiveness({ ping, onDead, options, now: () => now })
      monitor.noteOutbound()
      now += 2_000
      await vi.advanceTimersByTimeAsync(2_000)
      now += 3_600_000
      await vi.advanceTimersByTimeAsync(5_000)
      expect(onDead).not.toHaveBeenCalled()
      expect(ping).toHaveBeenCalledTimes(2)
      monitor.stop()
    })

    it('does nothing after stop', async () => {
      const { monitor, ping, onDead, advance } = start()
      monitor.noteOutbound()
      monitor.stop()
      await advance(10_000)
      monitor.noteOutbound()
      await advance(10_000)
      expect(ping).not.toHaveBeenCalled()
      expect(onDead).not.toHaveBeenCalled()
    })
  })
})
