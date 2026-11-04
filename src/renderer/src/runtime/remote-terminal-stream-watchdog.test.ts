import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS,
  createRemoteTerminalStreamWatchdog
} from './remote-terminal-stream-watchdog'

describe('remote terminal stream watchdog delivery deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('anchors the deadline to the oldest unsettled delivery instead of the last settled sibling', () => {
    const onStall = vi.fn()
    const watchdog = createRemoteTerminalStreamWatchdog(onStall)

    watchdog.beginOutputDelivery(100)
    for (let tick = 0; tick < 3; tick += 1) {
      vi.advanceTimersByTime(9_000)
      const settle = watchdog.beginOutputDelivery(10)
      settle()
    }
    expect(onStall).not.toHaveBeenCalled()

    vi.advanceTimersByTime(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS - 27_000)

    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0]?.[0]).toMatchObject({ reason: 'delivery-credit-timeout' })
  })

  it('stays quiet while continuous output keeps settling and acknowledging', () => {
    const onStall = vi.fn()
    const watchdog = createRemoteTerminalStreamWatchdog(onStall)

    // Each chunk parses 50ms and is acked 100ms after it lands, so bytes are always in flight.
    for (
      let elapsedMs = 0;
      elapsedMs < REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS * 4;
      elapsedMs += 20
    ) {
      const settle = watchdog.beginOutputDelivery(1_000)
      setTimeout(settle, 50)
      setTimeout(() => watchdog.recordOutputAcknowledged(1_000), 100)
      vi.advanceTimersByTime(20)
    }

    expect(onStall).not.toHaveBeenCalled()
  })

  it('trips 30s after the oldest unacknowledged chunk once ACKs stop, even while output keeps settling', () => {
    const onStall = vi.fn()
    const watchdog = createRemoteTerminalStreamWatchdog(onStall)

    // Healthy start: deliveries settle and are ACKed.
    for (let tick = 0; tick < 50; tick += 1) {
      watchdog.beginOutputDelivery(1_000)()
      watchdog.recordOutputAcknowledged(1_000)
      vi.advanceTimersByTime(20)
    }
    const ackStoppedAtMs = Date.now()
    // ACKs stop (only part of the oldest chunk is ever acknowledged) while output keeps settling.
    let partialAckSent = false
    let stalledAfterMs: number | null = null
    for (let tick = 0; tick < 2_000 && stalledAfterMs === null; tick += 1) {
      watchdog.beginOutputDelivery(1_000)()
      if (!partialAckSent) {
        watchdog.recordOutputAcknowledged(500)
        partialAckSent = true
      }
      vi.advanceTimersByTime(20)
      if (onStall.mock.calls.length > 0) {
        stalledAfterMs = Date.now() - ackStoppedAtMs
      }
    }

    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0]?.[0]).toMatchObject({ reason: 'delivery-credit-timeout' })
    expect(stalledAfterMs).toBeGreaterThanOrEqual(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS)
    expect(stalledAfterMs).toBeLessThanOrEqual(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS + 20)
  })

  it('drains a single ACK covering many tiny chunks without quadratic cost', () => {
    vi.useRealTimers()
    const onStall = vi.fn()
    const watchdog = createRemoteTerminalStreamWatchdog(onStall)
    const chunkCount = 200_000
    for (let index = 0; index < chunkCount; index += 1) {
      watchdog.beginOutputDelivery(1)()
    }

    const startedAt = performance.now()
    watchdog.recordOutputAcknowledged(chunkCount)
    const elapsedMs = performance.now() - startedAt
    watchdog.dispose()

    // Repeated Array.shift() takes seconds here; a head index takes a few ms.
    expect(elapsedMs).toBeLessThan(100)
  })

  it('stays armed while parsed bytes remain unacknowledged to the host', () => {
    const onStall = vi.fn()
    const watchdog = createRemoteTerminalStreamWatchdog(onStall)

    watchdog.beginOutputDelivery(100)()
    vi.advanceTimersByTime(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS)

    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall.mock.calls[0]?.[0]).toMatchObject({
      outstandingDeliveryBytes: 0,
      reason: 'delivery-credit-timeout'
    })
  })

  it('disarms once the acknowledgement reaches the transport', () => {
    const onStall = vi.fn()
    const watchdog = createRemoteTerminalStreamWatchdog(onStall)

    watchdog.beginOutputDelivery(100)()
    watchdog.recordOutputAcknowledged(100)
    vi.advanceTimersByTime(REMOTE_TERMINAL_DELIVERY_STALL_TIMEOUT_MS * 2)

    expect(onStall).not.toHaveBeenCalled()
  })
})
