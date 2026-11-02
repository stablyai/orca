// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeOffscreenAnimation } from './offscreen-animation-pause'

type Callback = (entries: Pick<IntersectionObserverEntry, 'target' | 'isIntersecting'>[]) => void

const observers: { callback: Callback; disconnect: ReturnType<typeof vi.fn> }[] = []

class FakeIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(callback: Callback) {
    observers.push({ callback, disconnect: this.disconnect })
  }
}

describe('observeOffscreenAnimation', () => {
  afterEach(() => {
    observers.length = 0
    vi.unstubAllGlobals()
  })

  it('shares one observer and disconnects it after the last release', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    const releaseFirst = observeOffscreenAnimation(document.createElement('span'))
    const releaseSecond = observeOffscreenAnimation(document.createElement('span'))
    expect(observers).toHaveLength(1)

    releaseFirst()
    expect(observers[0].disconnect).not.toHaveBeenCalled()
    releaseSecond()
    expect(observers[0].disconnect).toHaveBeenCalledOnce()

    observeOffscreenAnimation(document.createElement('span'))()
    expect(observers).toHaveLength(2)
  })
})
