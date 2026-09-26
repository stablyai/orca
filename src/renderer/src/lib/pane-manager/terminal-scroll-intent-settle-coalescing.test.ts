import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalScrollIntentTarget } from './terminal-scroll-intent'

const syncFromViewport = vi.fn()

vi.mock('./terminal-scroll-intent', () => ({
  syncTerminalScrollIntentFromViewport: (...args: unknown[]) => syncFromViewport(...args)
}))

const { syncTerminalScrollIntentSoon } = await import('./terminal-scroll-intent-settle')

let frameCallbacks: FrameRequestCallback[] = []

function flushFrames(): void {
  // Why: the double-frame phase queues its inner callback while draining, so run
  // until the queue is empty rather than over a snapshot of it.
  let guard = 0
  while (frameCallbacks.length > 0 && guard < 20) {
    const callbacks = frameCallbacks
    frameCallbacks = []
    for (const callback of callbacks) {
      callback(16)
    }
    guard += 1
  }
}

function createTerminal(): TerminalScrollIntentTarget {
  return {} as TerminalScrollIntentTarget
}

describe('syncTerminalScrollIntentSoon coalescing', () => {
  beforeEach(() => {
    syncFromViewport.mockClear()
    frameCallbacks = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })
    // Why: clearTimeout must be faked alongside setTimeout, otherwise the real
    // clearTimeout cannot cancel a fake timer and the debounce looks broken.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('collapses a burst of calls into one sync per phase instead of one per call', async () => {
    // Why: a trackpad delivers many wheel events per frame; each used to schedule its
    // own microtask, two frames and an 80ms settle.
    const terminal = createTerminal()

    for (let index = 0; index < 10; index += 1) {
      syncTerminalScrollIntentSoon(terminal)
    }

    await Promise.resolve()
    flushFrames()
    vi.advanceTimersByTime(80)

    // microtask + frame + double-frame + settle, once each, not ten times each.
    expect(syncFromViewport).toHaveBeenCalledTimes(4)
  })

  it('settles once after the last call rather than once per call', async () => {
    // Why: spacing the calls 30ms apart keeps every settle deadline in the future
    // at the point the baseline is taken, so an undebounced timer chain shows up as
    // three settles instead of one.
    const terminal = createTerminal()

    syncTerminalScrollIntentSoon(terminal)
    vi.advanceTimersByTime(30)
    syncTerminalScrollIntentSoon(terminal)
    vi.advanceTimersByTime(30)
    syncTerminalScrollIntentSoon(terminal)

    await Promise.resolve()
    flushFrames()
    const beforeSettle = syncFromViewport.mock.calls.length

    vi.advanceTimersByTime(200)

    expect(syncFromViewport.mock.calls.length).toBe(beforeSettle + 1)
  })

  it('keeps terminals independent', async () => {
    const first = createTerminal()
    const second = createTerminal()

    syncTerminalScrollIntentSoon(first)
    syncTerminalScrollIntentSoon(second)

    await Promise.resolve()

    expect(syncFromViewport).toHaveBeenCalledTimes(2)
    expect(syncFromViewport.mock.calls[0]?.[0]).toBe(first)
    expect(syncFromViewport.mock.calls[1]?.[0]).toBe(second)
  })

  it('applies the newest options so a later wheel does not inherit earlier pinning', async () => {
    const terminal = createTerminal()

    syncTerminalScrollIntentSoon(terminal, { preservePinnedAtBottom: true })
    syncTerminalScrollIntentSoon(terminal, { preservePinnedAtBottom: false })

    await Promise.resolve()

    expect(syncFromViewport).toHaveBeenCalledTimes(1)
    expect(syncFromViewport.mock.calls[0]?.[1]).toEqual({ preservePinnedAtBottom: false })
  })

  it('honors a shouldSync veto for both the immediate and settle phases', async () => {
    const terminal = createTerminal()

    syncTerminalScrollIntentSoon(terminal, { shouldSync: () => false })

    await Promise.resolve()
    flushFrames()
    vi.advanceTimersByTime(80)

    expect(syncFromViewport).not.toHaveBeenCalled()
  })
})
