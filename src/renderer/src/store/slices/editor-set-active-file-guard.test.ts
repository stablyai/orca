import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { createEditorTabsStore } from './editor-slice-test-harness'

const live = vi.hoisted((): { store: StoreApi<AppState> | null } => ({ store: null }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!live.store) {
        throw new Error('No test store')
      }
      return live.store.getState()
    }
  }
}))

const GHOST_ID = 'editor:ghost-pane'
let store: StoreApi<AppState>
let fileId: string

beforeEach(() => {
  store = createEditorTabsStore()
  live.store = store
  store.getState().openFile({
    filePath: '/repo/note.md',
    relativePath: 'note.md',
    worktreeId: 'wt-1',
    language: 'markdown',
    mode: 'edit'
  })
  const opened = store.getState().openFiles[0]
  if (!opened) {
    throw new Error('Document did not open')
  }
  fileId = opened.id
})

afterEach(() => {
  live.store = null
})

describe('setActiveFile with an id that has no open file', () => {
  it('premise: the open document is active', () => {
    expect(store.getState().activeFileId).toBe(fileId)
    expect(store.getState().activeFileIdByWorktree['wt-1']).toBe(fileId)
  })

  it('leaves the in-memory and per-workspace active file unchanged', () => {
    store.getState().setActiveFile(GHOST_ID)
    expect(store.getState().activeFileId).toBe(fileId)
    expect(store.getState().activeFileIdByWorktree['wt-1']).toBe(fileId)
  })

  it('leaves the per-workspace active file, which is what persists, unchanged', () => {
    store.getState().setActiveFile(GHOST_ID, 'wt-1')
    expect(store.getState().activeFileIdByWorktree['wt-1']).toBe(fileId)
  })
})
