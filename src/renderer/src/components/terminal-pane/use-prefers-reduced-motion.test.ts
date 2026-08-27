import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getPrefersReducedMotionSnapshot,
  resetPrefersReducedMotionSubscriptionForTests,
  subscribeToPrefersReducedMotionChange
} from './use-prefers-reduced-motion'

type MediaChangeListener = (event: MediaQueryListEvent) => void

function installMatchMedia(initialMatches: boolean): {
  media: {
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
    emit: (matches: boolean) => void
  }
  matchMedia: ReturnType<typeof vi.fn>
} {
  let matches = initialMatches
  const listeners = new Set<MediaChangeListener>()
  const media = {
    get matches() {
      return matches
    },
    addEventListener: vi.fn((type: string, listener: MediaChangeListener) => {
      if (type === 'change') {
        listeners.add(listener)
      }
    }),
    removeEventListener: vi.fn((type: string, listener: MediaChangeListener) => {
      if (type === 'change') {
        listeners.delete(listener)
      }
    }),
    emit(nextMatches: boolean): void {
      matches = nextMatches
      for (const listener of listeners) {
        listener({ matches: nextMatches } as MediaQueryListEvent)
      }
    }
  }
  const matchMedia = vi.fn(() => media as unknown as MediaQueryList)
  vi.stubGlobal('window', { matchMedia })
  return { media, matchMedia }
}

afterEach(() => {
  resetPrefersReducedMotionSubscriptionForTests()
  vi.unstubAllGlobals()
})

describe('usePrefersReducedMotion subscription store', () => {
  it('caches the initial media query snapshot', () => {
    const { matchMedia } = installMatchMedia(false)

    expect(getPrefersReducedMotionSnapshot()).toBe(false)
    expect(getPrefersReducedMotionSnapshot()).toBe(false)
    expect(matchMedia).toHaveBeenCalledTimes(1)
  })

  it('shares one media query listener across subscribers', () => {
    const { media, matchMedia } = installMatchMedia(true)
    const firstSubscriber = vi.fn()
    const secondSubscriber = vi.fn()

    const unsubscribeFirst = subscribeToPrefersReducedMotionChange(firstSubscriber)
    const unsubscribeSecond = subscribeToPrefersReducedMotionChange(secondSubscriber)

    expect(matchMedia).toHaveBeenCalledTimes(1)
    expect(media.addEventListener).toHaveBeenCalledTimes(1)

    media.emit(false)

    expect(getPrefersReducedMotionSnapshot()).toBe(false)
    expect(firstSubscriber).toHaveBeenCalledTimes(1)
    expect(secondSubscriber).toHaveBeenCalledTimes(1)

    unsubscribeFirst()
    expect(media.removeEventListener).not.toHaveBeenCalled()

    media.emit(true)

    expect(getPrefersReducedMotionSnapshot()).toBe(true)
    expect(firstSubscriber).toHaveBeenCalledTimes(1)
    expect(secondSubscriber).toHaveBeenCalledTimes(2)

    unsubscribeSecond()
    expect(media.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
