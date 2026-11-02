// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  OFFSCREEN_ANIMATION_ATTRIBUTE,
  observeOffscreenAnimation
} from './offscreen-animation-pause'

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

  it('marks elements only while they are outside the viewport', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    const element = document.createElement('span')
    const release = observeOffscreenAnimation(element)

    observers[0].callback([{ target: element, isIntersecting: false }])
    expect(element.hasAttribute(OFFSCREEN_ANIMATION_ATTRIBUTE)).toBe(true)
    observers[0].callback([{ target: element, isIntersecting: true }])
    expect(element.hasAttribute(OFFSCREEN_ANIMATION_ATTRIBUTE)).toBe(false)

    observers[0].callback([{ target: element, isIntersecting: false }])
    release()
    expect(element.hasAttribute(OFFSCREEN_ANIMATION_ATTRIBUTE)).toBe(false)
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

  it('leaves animations running where IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const element = document.createElement('span')
    observeOffscreenAnimation(element)()
    expect(element.hasAttribute(OFFSCREEN_ANIMATION_ATTRIBUTE)).toBe(false)
  })
})
