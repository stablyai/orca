import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('browser automation visibility leases', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        callback(0)
        return 1
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps a page visible until every lease is released', async () => {
    const {
      acquireBrowserAutomationVisibility,
      isBrowserAutomationVisible,
      releaseBrowserAutomationVisibility
    } = await import('./browser-automation-visibility')

    const first = acquireBrowserAutomationVisibility('page-1')
    const second = acquireBrowserAutomationVisibility('page-1')

    expect(isBrowserAutomationVisible('page-1')).toBe(true)

    expect(releaseBrowserAutomationVisibility(first)).toBe(true)
    expect(isBrowserAutomationVisible('page-1')).toBe(true)

    expect(releaseBrowserAutomationVisibility(second)).toBe(true)
    expect(isBrowserAutomationVisible('page-1')).toBe(false)
  })

  it('installs a main-process bridge that keeps the page visible while waiting for paint', async () => {
    const animationFrameCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('window', {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback)
        return animationFrameCallbacks.length
      }
    })
    const { isBrowserAutomationVisible } = await import('./browser-automation-visibility')

    const bridge = window.__orcaBrowserAutomationVisibility
    expect(bridge).toBeTruthy()

    const acquirePromise = bridge?.acquire('page-2')
    await Promise.resolve()

    expect(isBrowserAutomationVisible('page-2')).toBe(true)
    expect(animationFrameCallbacks).toHaveLength(1)

    animationFrameCallbacks.shift()?.(0)
    await Promise.resolve()

    expect(isBrowserAutomationVisible('page-2')).toBe(true)
    expect(animationFrameCallbacks).toHaveLength(1)

    animationFrameCallbacks.shift()?.(16)
    const token = await acquirePromise

    expect(typeof token).toBe('string')
    expect(isBrowserAutomationVisible('page-2')).toBe(true)
    expect(bridge?.release(token ?? '')).toBe(true)
    expect(isBrowserAutomationVisible('page-2')).toBe(false)
  })

  it('releases the main-process bridge lease when the paint wait hangs', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      requestAnimationFrame: () => 1
    })
    try {
      const { isBrowserAutomationVisible } = await import('./browser-automation-visibility')

      const bridge = window.__orcaBrowserAutomationVisibility
      expect(bridge).toBeTruthy()

      const acquirePromise = bridge?.acquire('page-hung-paint')
      await Promise.resolve()

      expect(isBrowserAutomationVisible('page-hung-paint')).toBe(true)

      await vi.advanceTimersByTimeAsync(2_000)
      await expect(acquirePromise).resolves.toBeNull()

      expect(isBrowserAutomationVisible('page-hung-paint')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
