import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scheduleAfterAnimationFrameOrTimeout } from './schedule-after-animation-frame-or-timeout'

describe('scheduleAfterAnimationFrameOrTimeout', () => {
  let frameCallback: FrameRequestCallback | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    frameCallback = null
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frameCallback = callback
        return 7
      })
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('runs once on the animation frame and ignores the timeout fallback afterward', () => {
    const callback = vi.fn()

    scheduleAfterAnimationFrameOrTimeout(callback)
    frameCallback?.(16)
    vi.advanceTimersByTime(100)

    expect(callback).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrame).not.toHaveBeenCalled()
  })

  it('runs once through the timeout fallback when the animation frame does not fire', () => {
    const callback = vi.fn()

    scheduleAfterAnimationFrameOrTimeout(callback)
    vi.advanceTimersByTime(99)
    expect(callback).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    frameCallback?.(16)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(7)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('does not run after cancellation', () => {
    const callback = vi.fn()

    const scheduled = scheduleAfterAnimationFrameOrTimeout(callback)
    scheduled.cancel()
    vi.advanceTimersByTime(100)
    frameCallback?.(16)

    expect(cancelAnimationFrame).toHaveBeenCalledWith(7)
    expect(callback).not.toHaveBeenCalled()
  })
})
