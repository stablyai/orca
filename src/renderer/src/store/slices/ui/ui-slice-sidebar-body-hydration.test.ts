import { describe, expect, it } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

describe('sidebar list hydration', () => {
  it('restores the list picked before restart without following other windows later', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sidebarBody: 'conversations' }), 'startup')
    expect(store.getState().sidebarBody).toBe('conversations')

    store.getState().setSidebarBody('agents')
    store.getState().hydratePersistedUI(makePersistedUI({ sidebarBody: 'workspaces' }), 'sync')
    expect(store.getState().sidebarBody).toBe('agents')
  })
})
