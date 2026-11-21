import { describe, expect, it } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

describe('sidebar view hydration', () => {
  it('opens on the view picked before restart without following other windows later', () => {
    const store = createUIStore()
    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ sidebarView: 'conversations' }), 'startup')
    expect(store.getState()).toMatchObject({
      sidebarView: 'conversations',
      sidebarBody: 'conversations'
    })

    store.getState().setSidebarBody('agents')
    store.getState().hydratePersistedUI(makePersistedUI({ sidebarView: 'workspaces' }), 'sync')
    expect(store.getState()).toMatchObject({ sidebarView: 'conversations', sidebarBody: 'agents' })
  })
})
