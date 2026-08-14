import { createStore, type StoreApi } from 'zustand/vanilla'
import { describe, expect, it, vi } from 'vitest'
import { createEditorSlice } from './editor'
import type { AppState } from '../types'

function createStoreViewing(activeWorktreeId: string): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    activeWorktreeId,
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    repos: [{ id: 'repo-1', path: '/repo' }],
    worktreesByRepo: {
      'repo-1': [
        { id: 'wt-a', repoId: 'repo-1', path: '/repo/a' },
        { id: 'wt-b', repoId: 'repo-1', path: '/repo/b' }
      ]
    },
    folderWorkspaces: [],
    projectGroups: [],
    recordFeatureInteraction: vi.fn(),
    ...createEditorSlice(...(args as Parameters<typeof createEditorSlice>))
  })) as unknown as StoreApi<AppState>
}

describe('setActiveTabTypeForWorktree', () => {
  it('does not change the visible pane when the target is a background worktree', () => {
    const store = createStoreViewing('wt-b')
    store.setState({ activeTabType: 'editor', activeTabTypeByWorktree: { 'wt-b': 'editor' } })

    store.getState().setActiveTabTypeForWorktree('wt-a', 'terminal')

    const state = store.getState()
    expect(state.activeTabType).toBe('editor')
    expect(state.activeTabTypeByWorktree['wt-b']).toBe('editor')
    // The launch target still remembers it should show terminals when opened.
    expect(state.activeTabTypeByWorktree['wt-a']).toBe('terminal')
  })

  it('changes the visible pane when the target is the viewed worktree', () => {
    const store = createStoreViewing('wt-a')
    store.setState({ activeTabType: 'editor', activeTabTypeByWorktree: { 'wt-a': 'editor' } })

    store.getState().setActiveTabTypeForWorktree('wt-a', 'terminal')

    const state = store.getState()
    expect(state.activeTabType).toBe('terminal')
    expect(state.activeTabTypeByWorktree['wt-a']).toBe('terminal')
  })

  it('preserves the state reference on a no-op so persistence does not fan out', () => {
    const store = createStoreViewing('wt-a')
    store.setState({ activeTabType: 'terminal', activeTabTypeByWorktree: { 'wt-a': 'terminal' } })
    const before = store.getState()

    before.setActiveTabTypeForWorktree('wt-a', 'terminal')

    expect(store.getState()).toBe(before)
  })

  it('still fixes a desynced global when the viewed target is already stamped', () => {
    const store = createStoreViewing('wt-a')
    // Remembered type already matches, but the visible pane disagrees.
    store.setState({ activeTabType: 'editor', activeTabTypeByWorktree: { 'wt-a': 'terminal' } })

    store.getState().setActiveTabTypeForWorktree('wt-a', 'terminal')

    expect(store.getState().activeTabType).toBe('terminal')
  })

  it('leaves the viewed pane alone when a background target is already stamped', () => {
    const store = createStoreViewing('wt-b')
    store.setState({ activeTabType: 'editor', activeTabTypeByWorktree: { 'wt-a': 'terminal' } })
    const before = store.getState()

    before.setActiveTabTypeForWorktree('wt-a', 'terminal')

    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState()).toBe(before)
  })
})
