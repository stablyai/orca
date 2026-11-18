import { describe, expect, it } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

describe('persisted UI hydration', () => {
  it('keeps unchanged fields when one field changes, as when main echoes a write', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ collapsedGroups: ['repo:a'], sidebarWidth: 300 }),
        'startup'
      )
    const collapsedGroups = store.getState().collapsedGroups

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ collapsedGroups: ['repo:a'], sidebarWidth: 320 }))

    expect(store.getState().sidebarWidth).toBe(320)
    expect(store.getState().collapsedGroups).toBe(collapsedGroups)
  })
})
