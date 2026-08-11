import { afterEach, describe, expect, it, vi } from 'vitest'
import { SharedControlReconnectScheduler } from './remote-runtime-shared-control-reconnect'

afterEach(() => {
  vi.useRealTimers()
})

describe('SharedControlReconnectScheduler', () => {
  it('advances one pending backoff without leaving its timer armed', async () => {
    vi.useFakeTimers()
    const scheduler = new SharedControlReconnectScheduler()
    const open = vi.fn()
    scheduler.schedule({ intentionallyClosed: false, delaysMs: [30_000], open })

    expect(scheduler.retryNow()).toBe(true)
    expect(scheduler.retryNow()).toBe(false)
    expect(open).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not advance cleared or intentionally closed work', () => {
    vi.useFakeTimers()
    const scheduler = new SharedControlReconnectScheduler()
    const open = vi.fn()
    scheduler.schedule({ intentionallyClosed: false, delaysMs: [30_000], open })
    scheduler.clear()

    expect(scheduler.retryNow()).toBe(false)

    scheduler.schedule({ intentionallyClosed: true, delaysMs: [30_000], open })
    expect(scheduler.retryNow()).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })
})
