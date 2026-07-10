import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribePromptCacheCountdownClock } from './prompt-cache-countdown-clock'

describe('subscribePromptCacheCountdownClock', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses one interval for all prompt-cache countdown subscribers', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = subscribePromptCacheCountdownClock(first)
    const unsubscribeSecond = subscribePromptCacheCountdownClock(second)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_000)

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(2)
    unsubscribeFirst()
    vi.advanceTimersByTime(1_000)

    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(3)
    unsubscribeSecond()
    vi.advanceTimersByTime(1_000)

    expect(second).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses the interval while the document is hidden', () => {
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

    const listener = vi.fn()
    const unsubscribe = subscribePromptCacheCountdownClock(listener)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(2_000)
    expect(listener).toHaveBeenCalledTimes(1)

    visibilityState = 'visible'
    vi.setSystemTime(3_000)
    documentListeners.get('visibilitychange')?.()
    expect(listener).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(1_000)
    expect(listener).toHaveBeenCalledTimes(3)

    visibilityState = 'hidden'
    documentListeners.get('visibilitychange')?.()
    expect(vi.getTimerCount()).toBe(0)

    unsubscribe()
    expect(document.removeEventListener).toHaveBeenCalledWith(
      'visibilitychange',
      documentListeners.get('visibilitychange')
    )
  })
})
