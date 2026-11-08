// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSharedNowClock, useNow } from './use-now'

describe('createSharedNowClock', () => {
  afterEach(() => {
    // Only the hidden-window test stubs `document`; unstub so it can't leak.
    vi.unstubAllGlobals()
  })

  it('shares one timer across subscribers and clears it when idle', () => {
    let now = 1_000
    const intervalCallbacks: (() => void)[] = []
    const handle = {} as ReturnType<typeof setInterval>
    const setIntervalMock = vi.fn((callback: () => void) => {
      intervalCallbacks.push(callback)
      return handle
    })
    const clearIntervalMock = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const clock = createSharedNowClock(30_000, {
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    })

    const unsubscribeFirst = clock.subscribe(first)
    const unsubscribeSecond = clock.subscribe(second)

    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    now = 31_000
    const intervalCallback = intervalCallbacks[0]
    if (!intervalCallback) {
      throw new Error('expected shared clock to schedule an interval')
    }
    intervalCallback()
    expect(clock.getSnapshot()).toBe(31_000)
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1)

    unsubscribeFirst()
    expect(clearIntervalMock).not.toHaveBeenCalled()
    unsubscribeSecond()
    expect(clearIntervalMock).toHaveBeenCalledWith(handle)
  })

  it('does not arm the timer while hidden and catches up when the window becomes visible', () => {
    let visibilityState: DocumentVisibilityState = 'hidden'
    const documentListeners = new Map<string, () => void>()
    vi.stubGlobal('document', {
      get visibilityState() {
        return visibilityState
      },
      addEventListener: vi.fn((event: string, listener: () => void) => {
        documentListeners.set(event, listener)
      }),
      removeEventListener: vi.fn()
    })

    let now = 1_000
    const handle = {} as ReturnType<typeof setInterval>
    const setIntervalMock = vi.fn(() => handle)
    const clearIntervalMock = vi.fn()
    const listener = vi.fn()
    const clock = createSharedNowClock(30_000, {
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    })

    const unsubscribe = clock.subscribe(listener)
    expect(setIntervalMock).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(clock.getSnapshot()).toBe(1_000)

    now = 90_000
    visibilityState = 'visible'
    documentListeners.get('visibilitychange')?.()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(clock.getSnapshot()).toBe(90_000)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)

    visibilityState = 'hidden'
    documentListeners.get('visibilitychange')?.()
    expect(clearIntervalMock).toHaveBeenCalledWith(handle)

    unsubscribe()
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      documentListeners.get('visibilitychange')
    )
  })
})

describe('useNow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not tick or hold the shared timer open while disabled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const hook = renderHook(({ enabled }: { enabled: boolean }) => useNow(1_000, enabled), {
      initialProps: { enabled: false }
    })
    expect(hook.result.current).toBe(1_000)

    act(() => vi.advanceTimersByTime(5_000))
    expect(hook.result.current).toBe(1_000)

    vi.setSystemTime(6_000)
    hook.rerender({ enabled: true })
    expect(hook.result.current).toBe(6_000)

    act(() => vi.advanceTimersByTime(1_000))
    expect(hook.result.current).toBe(7_000)
  })
})
