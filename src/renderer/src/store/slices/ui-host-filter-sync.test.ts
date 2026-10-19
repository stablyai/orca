import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore, makePersistedUI } from './ui-slice-test-harness'

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
})
afterEach(() => vi.unstubAllGlobals())

describe('host visibility across saved UI broadcasts', () => {
  it('keeps a newly revealed remote host when an older UI snapshot arrives', () => {
    const store = createUIStore()
    const previous = makePersistedUI({
      workspaceHostScope: 'local',
      visibleWorkspaceHostIds: ['local']
    })
    store.getState().hydratePersistedUI(previous)

    store.getState().setVisibleWorkspaceHostIds(['local', 'runtime:m4air'])
    store.getState().hydratePersistedUI(previous, 'sync')

    expect(store.getState().visibleWorkspaceHostIds).toEqual(['local', 'runtime:m4air'])
  })

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

  it('accepts another client’s host selection when there is no local edit', () => {
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI())
    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceHostScope: 'runtime:m4air',
        visibleWorkspaceHostIds: ['runtime:m4air']
      }),
      'sync'
    )

    expect(store.getState().workspaceHostScope).toBe('runtime:m4air')
    expect(store.getState().visibleWorkspaceHostIds).toEqual(['runtime:m4air'])
  })
})
