import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getSystemPrefersDarkSnapshot,
  resetSystemPrefersDarkSubscriptionForTests,
  subscribeToSystemPrefersDarkChange
} from './use-system-prefers-dark'

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
  resetSystemPrefersDarkSubscriptionForTests()
  vi.unstubAllGlobals()
})

describe('useSystemPrefersDark subscription store', () => {
  it('caches the initial media query snapshot', () => {
    const { matchMedia } = installMatchMedia(false)

    expect(getSystemPrefersDarkSnapshot()).toBe(false)
    expect(getSystemPrefersDarkSnapshot()).toBe(false)
    expect(matchMedia).toHaveBeenCalledTimes(1)
  })

  it('shares one media query listener across subscribers', () => {
    const { media, matchMedia } = installMatchMedia(true)
    const firstSubscriber = vi.fn()
    const secondSubscriber = vi.fn()

    const unsubscribeFirst = subscribeToSystemPrefersDarkChange(firstSubscriber)
    const unsubscribeSecond = subscribeToSystemPrefersDarkChange(secondSubscriber)

    expect(matchMedia).toHaveBeenCalledTimes(1)
    expect(media.addEventListener).toHaveBeenCalledTimes(1)

    media.emit(false)

    expect(getSystemPrefersDarkSnapshot()).toBe(false)
    expect(firstSubscriber).toHaveBeenCalledTimes(1)
    expect(secondSubscriber).toHaveBeenCalledTimes(1)

    unsubscribeFirst()
    expect(media.removeEventListener).not.toHaveBeenCalled()

    media.emit(true)

    expect(getSystemPrefersDarkSnapshot()).toBe(true)
    expect(firstSubscriber).toHaveBeenCalledTimes(1)
    expect(secondSubscriber).toHaveBeenCalledTimes(2)

    unsubscribeSecond()
    expect(media.removeEventListener).toHaveBeenCalledTimes(1)
  })
})
