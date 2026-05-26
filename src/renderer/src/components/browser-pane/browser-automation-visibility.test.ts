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

  it('installs a main-process bridge that waits for paint before returning a token', async () => {
    const { isBrowserAutomationVisible } = await import('./browser-automation-visibility')

    const bridge = window.__orcaBrowserAutomationVisibility
    expect(bridge).toBeTruthy()

    const token = await bridge?.acquire('page-2')

    expect(typeof token).toBe('string')
    expect(isBrowserAutomationVisible('page-2')).toBe(true)
    expect(bridge?.release(token ?? '')).toBe(true)
    expect(isBrowserAutomationVisible('page-2')).toBe(false)
  })
})
