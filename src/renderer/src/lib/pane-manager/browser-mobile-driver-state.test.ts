import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getBrowserMobileDrivenPageIds,
  getDriverForBrowserPage,
  hasMobileDriverForAnyBrowserPage,
  hydrateBrowserDrivers,
  isBrowserPageMobileDriven,
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

    expect(getDriverForBrowserPage('page-1')).toEqual({ kind: 'desktop' })
    expect(isBrowserPageMobileDriven('page-1')).toBe(false)
    expect(hasMobileDriverForAnyBrowserPage(['page-1'])).toBe(false)

    setDriverForBrowserPage('page-1', { kind: 'idle' })

    expect(getDriverForBrowserPage('page-1')).toEqual({ kind: 'idle' })
  })

  it('hydrates driver snapshots and notifies affected listeners', () => {
    setDriverForBrowserPage('page-old', { kind: 'mobile', clientId: 'phone-old' })
    const listener = vi.fn()
    const unsub = onBrowserDriverChange(listener)

    hydrateBrowserDrivers([
      { browserPageId: 'page-new', driver: { kind: 'mobile', clientId: 'phone-new' } }
    ])

    expect(getDriverForBrowserPage('page-old')).toEqual({ kind: 'idle' })
    expect(getDriverForBrowserPage('page-new')).toEqual({
      kind: 'mobile',
      clientId: 'phone-new'
    })
    expect(listener).toHaveBeenCalledWith({
      browserPageId: 'page-old',
      driver: { kind: 'idle' }
    })
    expect(listener).toHaveBeenCalledWith({
      browserPageId: 'page-new',
      driver: { kind: 'mobile', clientId: 'phone-new' }
    })

    unsub()
  })
})
