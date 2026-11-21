import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSharedNowClock } from './use-now'

describe('createSharedNowClock', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('refreshes a stale snapshot on the first subscribe even while the window is hidden', () => {
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener: () => {},
      removeEventListener: () => {}
    })
    const times = [1_000, 90_000]
    const clock = createSharedNowClock(1_000, {
      now: () => times.shift() ?? 90_000,
      setInterval: () => setTimeout(() => {}, 0),
      clearInterval: (handle) => clearTimeout(handle)
    })
    expect(clock.getSnapshot()).toBe(1_000)
    const unsubscribe = clock.subscribe(() => {})
    expect(clock.getSnapshot()).toBe(90_000)
    unsubscribe()
  })
})
