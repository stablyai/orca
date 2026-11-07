import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'

const STORAGE_KEY = 'orca.workspace-grid-view.members.v1'

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    values
  }
}

function makeStore(activeWorktreeId: string | null) {
  const store = createTestStore()
  store.setState({ activeWorktreeId })
  return store
}

describe('createWorkspaceGridViewSlice', () => {
  let storage: ReturnType<typeof createMemoryStorage>

  beforeEach(() => {
    storage = createMemoryStorage()
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts empty when nothing was saved', () => {
    expect(makeStore('a').getState().workspaceGridViewMemberIds).toEqual([])
  })

  it('adds the active workspace and the chosen one, then saves the grid view', () => {
    const store = makeStore('a')
    store.getState().addWorkspaceToGridView('b')
    expect(store.getState().workspaceGridViewMemberIds).toEqual(['a', 'b'])
    expect(storage.values.get(STORAGE_KEY)).toBe(JSON.stringify(['a', 'b']))
  })

  it('restores a saved grid view on startup', () => {
    storage.values.set(STORAGE_KEY, JSON.stringify(['a', 'b', 'c']))
    expect(makeStore('a').getState().workspaceGridViewMemberIds).toEqual(['a', 'b', 'c'])
  })

  it('ignores saved grid views that are malformed or too small to show', () => {
    storage.values.set(STORAGE_KEY, '{not json')
    expect(makeStore('a').getState().workspaceGridViewMemberIds).toEqual([])
    storage.values.set(STORAGE_KEY, JSON.stringify(['a', 7, 'a']))
    expect(makeStore('a').getState().workspaceGridViewMemberIds).toEqual([])
  })

  it('removes the saved grid view once it drops below two workspaces', () => {
    const store = makeStore('a')
    store.getState().addWorkspaceToGridView('b')
    store.getState().removeWorkspaceFromGridView('b')
    expect(store.getState().workspaceGridViewMemberIds).toEqual([])
    expect(storage.values.has(STORAGE_KEY)).toBe(false)
  })

  it('lets a full grid view of removed workspaces take a new member and saves the pruned list', () => {
    const removed = ['gone-1', 'gone-2', 'gone-3', 'gone-4', 'gone-5', 'gone-6']
    storage.values.set(STORAGE_KEY, JSON.stringify(removed))
    const store = makeStore('a')
    expect(store.getState().workspaceGridViewMemberIds).toEqual(removed)

    store.getState().addWorkspaceToGridView('b')

    expect(store.getState().workspaceGridViewMemberIds).toEqual(['a', 'b'])
    expect(storage.values.get(STORAGE_KEY)).toBe(JSON.stringify(['a', 'b']))
  })

  it('keeps working for the session when device storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      }
    })
    const store = makeStore('a')
    store.getState().addWorkspaceToGridView('b')
    expect(store.getState().workspaceGridViewMemberIds).toEqual(['a', 'b'])
  })
})
