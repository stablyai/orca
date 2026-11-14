import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('host visibility across saved UI broadcasts', () => {
  it('keeps All hosts while the prior selection is being saved', () => {
    const store = createUIStore()
    const previous = makePersistedUI({ workspaceHostScope: 'all', visibleWorkspaceHostIds: null })
    store.getState().hydratePersistedUI(previous)
    const fields = ['workspaceHostScope', 'visibleWorkspaceHostIds'] as const
    store.getState().setWorkspaceHostScope('local')
    store.getState().notePersistedUIWriteStarted(fields)
    store.getState().setWorkspaceHostScope('all')

    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ workspaceHostScope: 'local', visibleWorkspaceHostIds: ['local'] }),
        'sync'
      )

    expect(store.getState().workspaceHostScope).toBe('all')
    expect(store.getState().visibleWorkspaceHostIds).toBeNull()
  })
})
