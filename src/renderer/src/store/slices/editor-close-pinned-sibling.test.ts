import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { OpenFile } from './editor'
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

let store: StoreApi<AppState>
let file: OpenFile

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
  file = opened
})

afterEach(() => {
  live.store = null
})

// A clean same-owner twin of `file`, shown in its own tab.
function addPinnedSibling(): OpenFile {
  const sibling = { ...file, id: 'duplicate-record' }
  store.setState({ openFiles: [...store.getState().openFiles, sibling] })
  store.getState().createUnifiedTab(sibling.worktreeId, 'editor', {
    id: 'duplicate-tab',
    entityId: sibling.id,
    label: 'note.md',
    activate: false
  })
  store.getState().pinTab('duplicate-tab')
  return sibling
}

describe('case 7: closing a document with a pinned clean sibling', () => {
  it('premise: the sibling tab is pinned and both records are open', () => {
    addPinnedSibling()
    const tabs = store.getState().unifiedTabsByWorktree['wt-1']
    expect(tabs.find((tab) => tab.id === 'duplicate-tab')?.isPinned).toBe(true)
    expect(store.getState().openFiles.map((open) => open.id)).toEqual([file.id, 'duplicate-record'])
  })

  it('keeps the pinned sibling record open', () => {
    const sibling = addPinnedSibling()
    store.getState().closeFile(file.id)
    expect(store.getState().openFiles).toEqual([sibling])
  })

  it('keeps the pinned sibling tab and closes only the named tab', () => {
    addPinnedSibling()
    store.getState().closeFile(file.id)
    const tabs = store.getState().unifiedTabsByWorktree['wt-1'] ?? []
    expect(tabs.map((tab) => [tab.id, tab.entityId])).toEqual([
      ['duplicate-tab', 'duplicate-record']
    ])
  })
})
