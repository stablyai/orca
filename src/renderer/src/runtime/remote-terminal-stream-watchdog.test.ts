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
