import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSharedNowClock } from './useNow'

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

  it('refreshes the snapshot when a new subscriber restarts an idle clock', () => {
    let now = 1_000
    const handle = {} as ReturnType<typeof setInterval>
    const setIntervalMock = vi.fn(() => handle)
    const clearIntervalMock = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const clock = createSharedNowClock(30_000, {
      now: () => now,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock
    })

    const unsubscribeFirst = clock.subscribe(first)
    expect(clock.getSnapshot()).toBe(1_000)
    unsubscribeFirst()

    now = 61_000
    clock.subscribe(second)

    expect(clock.getSnapshot()).toBe(61_000)
    expect(second).toHaveBeenCalledTimes(1)
    expect(setIntervalMock).toHaveBeenCalledTimes(2)
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
    // Hidden on mount: no timer armed, no forced render, snapshot untouched.
    expect(setIntervalMock).not.toHaveBeenCalled()
    expect(listener).not.toHaveBeenCalled()
    expect(clock.getSnapshot()).toBe(1_000)

    // Becoming visible catches the stale label up and arms the shared timer.
    now = 90_000
    visibilityState = 'visible'
    documentListeners.get('visibilitychange')?.()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(clock.getSnapshot()).toBe(90_000)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)

    // Hiding again stops the shared timer so it stops ticking in the background.
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
