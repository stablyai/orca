import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorSlice } from './editor'
import type { AppState } from '../types'

function createEditorStore(): StoreApi<AppState> {
  // Only the editor slice + activeWorktreeId are needed for these tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId: 'wt-1',
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    recordFeatureInteraction: vi.fn(),
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

describe('setGitStatus gitStatusManagedByByWorktree', () => {
  it('populates the map when status.managedBy is set', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      branch: 'refs/heads/gitbutler/workspace',
      managedBy: 'gitbutler'
    })

    expect(store.getState().gitStatusManagedByByWorktree['wt-1']).toBe('gitbutler')
  })

  it('clears the key when managedBy is absent on a later status', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      managedBy: 'gitbutler'
    })
    expect(store.getState().gitStatusManagedByByWorktree['wt-1']).toBe('gitbutler')

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      branch: 'refs/heads/main'
    })

    expect(store.getState().gitStatusManagedByByWorktree).not.toHaveProperty('wt-1')
  })

  it('keeps the map referentially stable when managedBy is unchanged', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      managedBy: 'gitbutler'
    })
    const first = store.getState().gitStatusManagedByByWorktree

    // Re-apply an identical status: nothing about managedBy changed.
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      managedBy: 'gitbutler'
    })

    expect(store.getState().gitStatusManagedByByWorktree).toBe(first)
  })

  it('does not populate the map for a normal repo (managedBy absent)', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'unknown',
      entries: [],
      branch: 'refs/heads/main'
    })

    expect(store.getState().gitStatusManagedByByWorktree).not.toHaveProperty('wt-1')
  })
})
