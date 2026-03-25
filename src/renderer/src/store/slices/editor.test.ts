import { createStore } from 'zustand/vanilla'
import { describe, expect, it } from 'vitest'
import { createEditorSlice } from './editor'
import type { AppState } from '../types'

function createEditorStore() {
  return createStore<AppState>()((...args) => ({
    activeWorktreeId: 'wt-1',
    ...createEditorSlice(...args)
  })) as ReturnType<typeof createStore<AppState>>
}

describe('createEditorSlice openDiff', () => {
  it('keeps staged and unstaged diffs in separate tabs', () => {
    const store = createEditorStore()

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', false)
    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', true)

    expect(store.getState().openFiles.map((file) => file.id)).toEqual([
      '/repo/file.ts::unstaged',
      '/repo/file.ts::staged'
    ])
  })

  it('repairs an existing diff tab entry to the correct mode and staged state', () => {
    const store = createEditorStore()

    store.setState({
      openFiles: [
        {
          id: '/repo/file.ts::staged',
          filePath: '/repo/file.ts',
          relativePath: 'file.ts',
          worktreeId: 'wt-1',
          language: 'typescript',
          isDirty: false,
          mode: 'edit'
        }
      ],
      activeFileId: null,
      activeFileIdByWorktree: {},
      activeTabTypeByWorktree: {},
      activeTabType: 'terminal'
    })

    store.getState().openDiff('wt-1', '/repo/file.ts', 'file.ts', 'typescript', true)

    expect(store.getState().openFiles).toEqual([
      expect.objectContaining({
        id: '/repo/file.ts::staged',
        mode: 'diff',
        diffStaged: true
      })
    ])
    expect(store.getState().activeFileId).toBe('/repo/file.ts::staged')
  })
})
