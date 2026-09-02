import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPanelWatchdog } from './plugin-panel-watchdog'

describe('createPanelWatchdog', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('can start again after StrictMode-style setup cleanup', () => {
    const sendPing = vi.fn()
    const onUnresponsive = vi.fn()
    const watchdog = createPanelWatchdog({
      sendPing,
      onUnresponsive,
      pingIntervalMs: 100,
      pongTimeoutMs: 50
    })

    watchdog.start()
    watchdog.stop()
    watchdog.start()
    expect(sendPing.mock.calls.map(([pingId]) => pingId)).toEqual([0, 1])

    watchdog.handlePong(1)
    vi.advanceTimersByTime(100)
    watchdog.handlePong(2)
    expect(onUnresponsive).not.toHaveBeenCalled()

    watchdog.stop()
    vi.advanceTimersByTime(1_000)
    expect(onUnresponsive).not.toHaveBeenCalled()
  })

  it('clears its interval when a pong deadline expires', () => {
    const sendPing = vi.fn()
    const onUnresponsive = vi.fn()
    const watchdog = createPanelWatchdog({
      sendPing,
      onUnresponsive,
      pingIntervalMs: 100,
      pongTimeoutMs: 50
    })

    watchdog.start()
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(1_000)

    expect(onUnresponsive).toHaveBeenCalledTimes(1)
    expect(sendPing).toHaveBeenCalledTimes(1)
  })
})
