import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('browser automation visibility leases', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('keeps a page visible until every lease is released', async () => {
    const {
      acquireBrowserAutomationVisibility,
      isBrowserAutomationVisible,
      onBrowserAutomationVisibilityChange,
      releaseBrowserAutomationVisibility
    } = await import('./browser-automation-visibility')
    const listener = vi.fn()
    const unsubscribe = onBrowserAutomationVisibilityChange(listener)

    const first = acquireBrowserAutomationVisibility('page-1')
    const second = acquireBrowserAutomationVisibility('page-1')

    expect(isBrowserAutomationVisible('page-1')).toBe(true)

    expect(releaseBrowserAutomationVisibility(first)).toBe(true)
    expect(isBrowserAutomationVisible('page-1')).toBe(true)

    expect(releaseBrowserAutomationVisibility(second)).toBe(true)
    expect(isBrowserAutomationVisible('page-1')).toBe(false)
    expect(listener).toHaveBeenCalledTimes(4)

    unsubscribe()
    acquireBrowserAutomationVisibility('page-2')
    expect(listener).toHaveBeenCalledTimes(4)
  })
})
