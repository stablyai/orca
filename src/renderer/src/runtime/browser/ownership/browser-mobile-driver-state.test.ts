import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getBrowserMobileDrivenPageIds,
  hasMobileDriverForAnyBrowserPage,
  isBrowserPageMobileDriven,
  getDriverForBrowserPage,
  hydrateBrowserDrivers,
  onBrowserDriverChange,
  setDriverForBrowserPage
} from './browser-mobile-driver-state'

afterEach(() => {
  hydrateBrowserDrivers([])
})

describe('browser-mobile-driver-state', () => {
  it('stores and clears driver state keyed by browser page id', () => {
    setDriverForBrowserPage('page-1', { kind: 'mobile', clientId: 'phone-1' })
    setDriverForBrowserPage('page-2', { kind: 'desktop' })

    expect(getDriverForBrowserPage('page-1')).toEqual({ kind: 'mobile', clientId: 'phone-1' })
    expect(isBrowserPageMobileDriven('page-1')).toBe(true)
    expect(hasMobileDriverForAnyBrowserPage(['missing', 'page-1'])).toBe(true)
    expect([...getBrowserMobileDrivenPageIds(['missing', 'page-1', 'page-2'])]).toEqual(['page-1'])

    setDriverForBrowserPage('page-1', { kind: 'desktop' })

    expect(getDriverForBrowserPage('page-1')).toEqual({ kind: 'idle' })
    expect(isBrowserPageMobileDriven('page-1')).toBe(false)
    expect(hasMobileDriverForAnyBrowserPage(['page-1'])).toBe(false)

    setDriverForBrowserPage('page-1', { kind: 'idle' })

    expect(getDriverForBrowserPage('page-1')).toEqual({ kind: 'idle' })
  })

  it('notifies desktop take back without retaining the page', () => {
    const listener = vi.fn()
    const unsub = onBrowserDriverChange(listener)

    setDriverForBrowserPage('closed-page', { kind: 'desktop' })
    unsub()

    expect(listener).toHaveBeenCalledWith({
      browserPageId: 'closed-page',
      driver: { kind: 'desktop' }
    })
    expect(getDriverForBrowserPage('closed-page')).toEqual({ kind: 'idle' })
  })

  it('does not hydrate desktop drivers for closed pages', () => {
    hydrateBrowserDrivers([{ browserPageId: 'closed-page', driver: { kind: 'desktop' } }])

    expect(getDriverForBrowserPage('closed-page')).toEqual({ kind: 'idle' })
  })
})
