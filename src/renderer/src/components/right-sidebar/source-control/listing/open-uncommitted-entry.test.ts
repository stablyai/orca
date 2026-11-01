import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from '@/store/slices/editor-slice-test-harness'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { openUncommittedEntry } from './open-uncommitted-entry'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

function markdownEntry(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return {
    path: 'docs/new.md',
    status: 'untracked',
    area: 'untracked',
    ...overrides
  }
}

describe('openUncommittedEntry', () => {
  it.each(['source', 'changes'] as const)('preserves an explicit %s choice on reselect', (mode) => {
    const store = createEditorStore()
    const entry = markdownEntry()
    openUncommittedEntry(store.getState(), 'wt-1', '/repo', entry)
    const fileId = store.getState().openFiles[0].id
    if (mode === 'changes') {
      store.getState().setEditorViewMode(fileId, 'changes')
    } else {
      store.getState().setMarkdownViewMode(fileId, 'source')
    }

    openUncommittedEntry(store.getState(), 'wt-1', '/repo', entry)

    const state = store.getState()
    expect(state.openFiles).toHaveLength(1)
    expect(mode === 'changes' ? state.editorViewMode[fileId] : state.markdownViewMode[fileId]).toBe(
      mode
    )
  })
})
