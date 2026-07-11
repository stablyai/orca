import { describe, expect, it, vi } from 'vitest'
import { pushMode2031SeedReply } from './terminal-mode-2031-replies'

describe('pushMode2031SeedReply', () => {
  function createHarness(connected: boolean): {
    connected: { current: boolean }
    subscribed: { current: boolean }
    sendInput: ReturnType<typeof vi.fn<(data: string) => boolean>>
    sendInputImmediate: ReturnType<typeof vi.fn<(data: string) => boolean>>
    scheduled: (() => void)[]
    recordMode: ReturnType<typeof vi.fn>
    push: () => void
  } {
    const connectedState = { current: connected }
    const subscribed = { current: true }
    const sendInput = vi.fn<(data: string) => boolean>(() => true)
    const sendInputImmediate = vi.fn<(data: string) => boolean>(() => true)
    const scheduled: (() => void)[] = []
    const recordMode = vi.fn()
    const transport = {
      isConnected: () => connectedState.current,
      sendInput,
      sendInputImmediate
    }
    return {
      connected: connectedState,
      subscribed,
      sendInput,
      sendInputImmediate,
      scheduled,
      recordMode,
      push: () =>
        pushMode2031SeedReply(1, {
          hasPane: () => true,
          isSubscribed: () => subscribed.current,
          getTransport: () => transport,
          getMode: () => 'dark',
          recordMode,
          schedule: (callback) => scheduled.push(callback)
        })
    }
  }

  it('routes the color-scheme response through latency-critical input', () => {
    const harness = createHarness(true)

    harness.push()

    expect(harness.sendInputImmediate).toHaveBeenCalledWith('\x1b[?997;1n')
    expect(harness.sendInput).not.toHaveBeenCalled()
    expect(harness.recordMode).toHaveBeenCalledWith(1, 'dark')
  })

  it('cancels a pre-connect retry after the program unsubscribes', () => {
    const harness = createHarness(false)

    harness.push()
    expect(harness.scheduled).toHaveLength(1)

    harness.subscribed.current = false
    harness.connected.current = true
    harness.scheduled.shift()?.()

    expect(harness.sendInputImmediate).not.toHaveBeenCalled()
    expect(harness.sendInput).not.toHaveBeenCalled()
    expect(harness.scheduled).toHaveLength(0)
  })
})
