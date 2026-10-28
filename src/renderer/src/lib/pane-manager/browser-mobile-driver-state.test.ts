import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDriverForBrowserPage,
  hydrateBrowserDrivers,
  onBrowserDriverChange,
  setDriverForBrowserPage
} from './browser-mobile-driver-state'

afterEach(() => {
  hydrateBrowserDrivers([])
})

describe('browser-mobile-driver-state', () => {
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
