import { expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

it('clamps and saves the vertical tab list width and collapse, and restores them', () => {
  const set = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { ui: { set } } })
  try {
    const store = createUIStore()
    store.getState().setVerticalTabListWidth(9000)
    store.getState().setVerticalTabListCollapsed(true)
    expect(store.getState().verticalTabListWidth).toBe(480)
    expect(set).toHaveBeenCalledWith({ verticalTabListWidth: 480 })
    expect(set).toHaveBeenCalledWith({ verticalTabListCollapsed: true })

    // Another window's write arrives as a sync hydration.
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ verticalTabListWidth: 300, verticalTabListCollapsed: false }),
        'sync'
      )
    expect(store.getState().verticalTabListWidth).toBe(300)
    expect(store.getState().verticalTabListCollapsed).toBe(false)
  } finally {
    vi.unstubAllGlobals()
  }
})
